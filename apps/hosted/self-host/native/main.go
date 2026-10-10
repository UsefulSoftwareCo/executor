// The native host owns volume locks, key files, Git processes and workerd's lifetime.
// Product operations, authentication and telemetry execute in workerd.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// memoryPressureMiB is where workerd starts collecting garbage in every isolate: 60% of the
// container's cgroup v2 memory limit, leaving room below the limit for a collection to take
// effect before the kernel reclaims or kills. Zero, which turns the check off, when the limit
// file is missing or says "max".
func memoryPressureMiB(limitFile string) uint64 {
	limit, err := os.ReadFile(limitFile)
	if err != nil {
		return 0
	}
	limitBytes, err := strconv.ParseUint(strings.TrimSpace(string(limit)), 10, 64)
	if err != nil {
		return 0
	}
	return limitBytes / 1024 / 1024 * 60 / 100
}

func setting(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func randomKey() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func randomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func exists(path string) bool { _, err := os.Stat(path); return err == nil }
func saveKey(path, value string) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".key-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err = file.Chmod(0600); err == nil {
		_, err = io.WriteString(file, value)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(temporary, path); err != nil {
		return err
	}
	parent, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}
func configuration(directory string, exporting bool) (map[string]string, error) {
	values := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "EXECUTOR_") || strings.HasPrefix(name, "OTEL_") || strings.HasPrefix(name, "BETTER_AUTH_") || strings.HasPrefix(name, "SSO_") || strings.HasPrefix(name, "FIRST_PARTY_") || name == "NODE_ENV" || name == "DO_NOT_TRACK" {
			values[name] = value
		}
	}
	if exporting {
		values["EXECUTOR_STORAGE_EXPORT"] = "true"
		return values, nil
	}
	origin := os.Getenv("BETTER_AUTH_URL")
	if origin == "" {
		if domain := os.Getenv("RAILWAY_PUBLIC_DOMAIN"); domain != "" {
			if !regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$`).MatchString(domain) {
				return nil, errors.New("RAILWAY_PUBLIC_DOMAIN must be a hostname")
			}
			origin = "https://" + domain
		} else {
			origin = "http://localhost:" + setting("PORT", "4400")
		}
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash")
	}
	values["BETTER_AUTH_URL"] = origin
	values["EXECUTOR_REPOSITORIES_DIR"] = filepath.Join(directory, "repositories")
	existing := exists(filepath.Join(directory, "hosted.pglite")) || exists(filepath.Join(directory, "product"))
	keys := []struct {
		name, file string
		valid      func(string) bool
	}{
		{"BETTER_AUTH_SECRET", "auth-secret.key", func(v string) bool { return len(v) >= 32 }},
		{"EXECUTOR_ENCRYPTION_KEY", "encryption.key", func(v string) bool { return regexp.MustCompile(`^[0-9a-fA-F]{64}$`).MatchString(v) }},
	}
	for _, key := range keys {
		value := os.Getenv(key.name)
		saved := value == ""
		path := filepath.Join(directory, key.file)
		if value == "" {
			content, err := os.ReadFile(path)
			if err == nil {
				value = string(content)
				if err = os.Chmod(path, 0600); err != nil {
					return nil, err
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				return nil, err
			} else if existing {
				return nil, fmt.Errorf("%s is missing for an existing database; restore its original value", key.name)
			} else {
				value = randomKey()
				if err = saveKey(path, value); err != nil {
					return nil, err
				}
			}
		}
		if !key.valid(value) {
			if saved {
				return nil, fmt.Errorf("Saved %s is invalid; restore its original file or environment value", key.name)
			}
			return nil, fmt.Errorf("%s is invalid; restore its original value", key.name)
		}
		values[key.name] = value
	}
	// Analytics identity is not needed to read existing data: a missing or invalid file is replaced.
	identities := []struct {
		name, file string
		valid      func(string) bool
		generate   func() string
	}{
		{"EXECUTOR_INSTALL_ID", "install-id", func(v string) bool {
			return regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(v)
		}, randomUUID},
		{"EXECUTOR_ANALYTICS_SECRET", "analytics-secret.key", func(v string) bool { return regexp.MustCompile(`^[0-9a-fA-F]{64}$`).MatchString(v) }, randomKey},
	}
	for _, identity := range identities {
		if value := os.Getenv(identity.name); identity.valid(value) {
			values[identity.name] = value
			continue
		}
		path := filepath.Join(directory, identity.file)
		content, err := os.ReadFile(path)
		value := strings.TrimSpace(string(content))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if err != nil || !identity.valid(value) {
			value = identity.generate()
			if err = saveKey(path, value); err != nil {
				return nil, err
			}
		}
		values[identity.name] = value
	}
	// Node's platform names, matching the native hosts.
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	values["EXECUTOR_HOST_OS"] = runtime.GOOS
	values["EXECUTOR_HOST_ARCH"] = arch
	return values, nil
}

// Retain the previous proper-lockfile heartbeat, so an old image cannot open
// PostgreSQL while the workerd image owns the product volume.
func lockVolume(directory string) (func(), error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(directory, ".executor.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("run one Executor instance per product volume")
	}
	lock := filepath.Join(directory, "hosted.pglite.lock")
	if err = os.Mkdir(lock, 0700); errors.Is(err, os.ErrExist) {
		deadline := time.Now().Add(12 * time.Second)
		for {
			info, statErr := os.Stat(lock)
			if errors.Is(statErr, os.ErrNotExist) {
				break
			}
			if statErr != nil || time.Now().After(deadline) {
				file.Close()
				return nil, errors.New("the product volume is locked by another process")
			}
			if time.Since(info.ModTime()) >= 10*time.Second {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if err = os.Remove(lock); err == nil || errors.Is(err, os.ErrNotExist) {
			err = os.Mkdir(lock, 0700)
		}
	}
	if err != nil {
		file.Close()
		return nil, err
	}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case now := <-ticker.C:
				if err := os.Chtimes(lock, now, now); err != nil {
					fmt.Fprintln(os.Stderr, "Product volume lock heartbeat failed")
					os.Exit(1)
				}
			}
		}
	}()
	return func() { close(done); wg.Wait(); os.Remove(lock); file.Close() }, nil
}

type bridge struct {
	config                  map[string]string
	repositories, temporary string
	indexes                 sync.Map
}

func decode(w http.ResponseWriter, r *http.Request, body any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 48<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil {
		http.Error(w, "Invalid host request", 400)
		return false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		http.Error(w, "Invalid host request", 400)
		return false
	}
	return true
}
func reply(w http.ResponseWriter, value any) {
	w.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		return
	}
}
func (b *bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/configuration" && r.Method == "GET" {
		reply(w, b.config)
		return
	}
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	switch r.URL.Path {
	case "/git":
		var input struct {
			Args        []string          `json:"args"`
			Input       []byte            `json:"input"`
			Environment map[string]string `json:"environment"`
		}
		if !decode(w, r, &input) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "git", append([]string{"-c", "core.hooksPath=/dev/null"}, input.Args...)...)
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + b.temporary, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
		for name, value := range input.Environment {
			if !strings.HasPrefix(name, "GIT_") && !strings.HasPrefix(name, "CONTENT_") && !strings.HasPrefix(name, "REQUEST_") && name != "PATH_INFO" && name != "QUERY_STRING" && name != "REMOTE_USER" && name != "SERVER_PROTOCOL" {
				http.Error(w, "Invalid Git environment", 400)
				return
			}
			command.Env = append(command.Env, name+"="+value)
		}
		command.Stdin = bytes.NewReader(input.Input)
		command.Stderr = io.Discard
		output := &limitedOutput{maximum: 64 << 20}
		command.Stdout = output
		err := command.Run()
		code := 0
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			} else {
				http.Error(w, "Git process failed", 503)
				return
			}
		}
		if output.exceeded {
			http.Error(w, "Git output too large", 413)
			return
		}
		reply(w, struct {
			Code   int    `json:"code"`
			Output []byte `json:"output"`
		}{code, output.Bytes()})
	case "/git/directory":
		var input struct {
			Path string `json:"path"`
		}
		if !decode(w, r, &input) {
			return
		}
		if filepath.Dir(input.Path) != b.repositories || !regexp.MustCompile(`^[a-zA-Z0-9_-]+\.git$`).MatchString(filepath.Base(input.Path)) {
			http.Error(w, "Invalid repository", 400)
			return
		}
		if err := os.MkdirAll(input.Path, 0700); err != nil {
			http.Error(w, "Cannot create repository", 503)
			return
		}
		reply(w, struct{}{})
	case "/git/index":
		var input struct{}
		if !decode(w, r, &input) {
			return
		}
		directory, err := os.MkdirTemp(b.temporary, "index-")
		if err != nil {
			http.Error(w, "Cannot create index", 503)
			return
		}
		index := filepath.Join(directory, "index")
		b.indexes.Store(index, directory)
		reply(w, map[string]string{"index": index})
	case "/git/index/remove":
		var input struct {
			Index string `json:"index"`
		}
		if !decode(w, r, &input) {
			return
		}
		directory, ok := b.indexes.LoadAndDelete(input.Index)
		if !ok {
			http.Error(w, "Unknown index", 400)
			return
		}
		if err := os.RemoveAll(directory.(string)); err != nil {
			http.Error(w, "Cannot remove index", 503)
			return
		}
		reply(w, struct{}{})
	default:
		http.NotFound(w, r)
	}
}

type limitedOutput struct {
	bytes.Buffer
	maximum  int
	exceeded bool
}

func (b *limitedOutput) Write(data []byte) (int, error) {
	if b.Len()+len(data) > b.maximum {
		b.exceeded = true
		return 0, errors.New("output limit")
	}
	return b.Buffer.Write(data)
}

func serve(mode string) error {
	directory, err := filepath.Abs(setting("EXECUTOR_DATA_DIR", "/app/data"))
	if err != nil {
		return err
	}
	release, err := lockVolume(directory)
	if err != nil {
		return err
	}
	defer release()
	values, err := configuration(directory, mode == "export")
	if err != nil {
		return err
	}
	if mode == "export" {
		values["EXECUTOR_STORAGE_EXPORT"] = "true"
	}
	runtime, err := filepath.Abs(setting("EXECUTOR_RUNTIME_DIR", "/app"))
	if err != nil {
		return err
	}
	temporary, err := os.MkdirTemp("", "executor-host-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	motel, err := filepath.Abs(setting("EXECUTOR_MOTEL_DATA_DIR", "/app/motel-data"))
	if err != nil {
		return err
	}
	if motel == directory || strings.HasPrefix(motel, directory+string(os.PathSeparator)) || strings.HasPrefix(directory, motel+string(os.PathSeparator)) {
		return errors.New("EXECUTOR_MOTEL_DATA_DIR must be separate from the product data directory")
	}
	if mode == "export" {
		motel = filepath.Join(temporary, "motel")
	}
	if err = os.MkdirAll(motel, 0700); err != nil {
		return err
	}
	productRoot, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return err
	}
	motelRoot, err := filepath.EvalSymlinks(motel)
	if err != nil {
		return err
	}
	if motelRoot == productRoot || strings.HasPrefix(motelRoot, productRoot+string(os.PathSeparator)) || strings.HasPrefix(productRoot, motelRoot+string(os.PathSeparator)) {
		return errors.New("Motel and product data cannot share a datastore")
	}
	productInfo, err := os.Stat(productRoot)
	if err != nil {
		return err
	}
	motelInfo, err := os.Stat(motelRoot)
	if err != nil {
		return err
	}
	if os.SameFile(productInfo, motelInfo) {
		return errors.New("Motel and product data cannot share a datastore")
	}
	paths := map[string]string{"product-data": filepath.Join(directory, "product"), "legacy-data": filepath.Join(directory, "hosted.pglite"), "app-data": filepath.Join(directory, "workerd"), "workflow-data": filepath.Join(directory, "workerd", "workflows"), "builds": filepath.Join(directory, "builds")}
	if mode == "export" {
		// Export must not wake retained workflow alarms while their product callbacks
		// are offline. Only the product actor opens its live durable store.
		paths["app-data"] = filepath.Join(temporary, "apps")
		paths["workflow-data"] = filepath.Join(temporary, "workflows")
	}
	for _, path := range paths {
		if err = os.MkdirAll(path, 0700); err != nil {
			return err
		}
	}
	repositories := filepath.Join(directory, "repositories")
	if err = os.MkdirAll(repositories, 0700); err != nil {
		return err
	}
	for _, old := range []string{"app-data", "workflow-engine"} {
		entries, err := os.ReadDir(filepath.Join(directory, old))
		if err == nil && len(entries) > 0 {
			return errors.New("legacy app storage needs migration before this image can start")
		}
	}
	socket := filepath.Join(temporary, "native.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer listener.Close()
	server := &http.Server{Handler: &bridge{config: values, repositories: repositories, temporary: temporary}, ReadHeaderTimeout: 10 * time.Second}
	defer server.Close()
	serverError := make(chan error, 1)
	go func() { serverError <- server.Serve(listener) }()
	config, err := os.ReadFile(filepath.Join(runtime, "workerd.capnp"))
	if err != nil {
		return err
	}
	// The generated file contains paths, the dashboard origin, the npm registry and a network-policy boolean, never keys.
	// App requests for the dashboard origin reach the product through a service binding, so the
	// bundled Executor app never needs private fetch. Other private destinations are an explicit opt-in.
	privateFetch := values["EXECUTOR_APPS_ALLOW_PRIVATE_FETCH"]
	if privateFetch == "" || mode == "export" {
		privateFetch = "false"
	}
	if privateFetch != "true" && privateFetch != "false" {
		return errors.New("EXECUTOR_APPS_ALLOW_PRIVATE_FETCH must be true or false")
	}
	config = bytes.ReplaceAll(config, []byte("@@APPS_PRIVATE_FETCH@@"), []byte(privateFetch))
	// The most app Workers workerd keeps loaded; the apps Worker applies its default for null.
	appWorkers := "null"
	if value := values["EXECUTOR_APP_WORKERS"]; value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 1 {
			return errors.New("EXECUTOR_APP_WORKERS must be a positive integer")
		}
		appWorkers = strconv.Itoa(number)
	}
	config = bytes.ReplaceAll(config, []byte("@@APP_WORKERS@@"), []byte(appWorkers))
	// Seconds an idle app Worker stays loaded; zero turns idle unloading off, null keeps the default.
	appWorkerIdle := "null"
	if value := values["EXECUTOR_APP_WORKER_IDLE_SECONDS"]; value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 0 {
			return errors.New("EXECUTOR_APP_WORKER_IDLE_SECONDS must be a non-negative integer")
		}
		appWorkerIdle = strconv.Itoa(number)
	}
	config = bytes.ReplaceAll(config, []byte("@@APP_WORKER_IDLE_SECONDS@@"), []byte(appWorkerIdle))
	config = bytes.ReplaceAll(config, []byte("@@MEMORY_PRESSURE_MB@@"), []byte(strconv.FormatUint(memoryPressureMiB("/sys/fs/cgroup/memory.max"), 10)))
	config = bytes.ReplaceAll(config, []byte("@@SELF_ORIGIN@@"), []byte(strconv.Quote(values["BETTER_AUTH_URL"])))
	// App builds install packages from this registry; empty selects the public registry.
	registry := values["EXECUTOR_NPM_REGISTRY"]
	if registry != "" {
		parsed, err := url.Parse(registry)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
			return errors.New("EXECUTOR_NPM_REGISTRY must be an HTTP(S) URL")
		}
	}
	config = bytes.ReplaceAll(config, []byte("@@NPM_REGISTRY@@"), []byte(strconv.Quote(registry)))
	config = bytes.ReplaceAll(config, []byte("@@RUNTIME@@"), []byte(strings.Trim(strconv.Quote(runtime), "\"")))
	service := `"product"`
	if mode == "export" {
		service = `(name="product",entrypoint="ProductExport")`
	}
	config = bytes.ReplaceAll(config, []byte("@@PRODUCT_SERVICE@@"), []byte(service))
	certificates := []string{}
	if path := os.Getenv("NODE_EXTRA_CA_CERTS"); path != "" {
		bundle, err := os.ReadFile(path)
		if err != nil {
			return errors.New("Cannot read NODE_EXTRA_CA_CERTS")
		}
		for len(bytes.TrimSpace(bundle)) > 0 {
			block, rest := pem.Decode(bundle)
			if block == nil || block.Type != "CERTIFICATE" {
				return errors.New("NODE_EXTRA_CA_CERTS must contain PEM certificates")
			}
			if _, err := x509.ParseCertificate(block.Bytes); err != nil {
				return errors.New("Invalid extra CA certificate")
			}
			certificates = append(certificates, strconv.Quote(string(pem.EncodeToMemory(block))))
			bundle = rest
		}
	}
	config = bytes.ReplaceAll(config, []byte("@@EXTRA_CA_CERTIFICATES@@"), []byte(strings.Join(certificates, ",")))
	configPath := filepath.Join(temporary, "workerd.capnp")
	if err = os.WriteFile(configPath, config, 0600); err != nil {
		return err
	}
	port := setting("PORT", "4400")
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return errors.New("PORT must be between 1 and 65535")
	}
	// The collector listens only on a private Unix socket. The product reaches it through its MOTEL
	// binding and operators through `executor-host telemetry`; no address an app can fetch reaches it.
	// The socket lives in this host's own temporary directory, so containers that share TMPDIR and
	// mount their product volumes at the same path never share or remove each other's collector.
	collector := filepath.Join(temporary, "motel.sock")
	args := []string{"serve", configPath, "-I/", "--experimental", "--external-addr=native=unix:" + socket, "--external-addr=motel=unix:" + collector, "--socket-addr=http=unix:" + filepath.Join(temporary, "product.sock")}
	for name, path := range paths {
		args = append(args, "--directory-path="+name+"="+path)
	}
	if mode == "export" {
		args = append(args, "--socket-addr=http=unix:"+filepath.Join(temporary, "export.sock"))
	}
	command := exec.Command(filepath.Join(runtime, "workerd"), args...)
	configureChild(command)
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + temporary}
	for _, name := range []string{"SSL_CERT_FILE", "SSL_CERT_DIR"} {
		if value := os.Getenv(name); value != "" {
			command.Env = append(command.Env, name+"="+value)
		}
	}
	command.Dir = runtime
	if err = command.Start(); err != nil {
		return err
	}
	stopped := make(chan error, 1)
	go func() { stopped <- command.Wait() }()
	if mode == "export" {
		defer func() {
			command.Process.Signal(syscall.SIGTERM)
			select {
			case <-stopped:
			case <-time.After(15 * time.Second):
				command.Process.Kill()
				<-stopped
			}
		}()
		if len(os.Args) != 3 {
			return errors.New("usage: executor-host export /path/to/new-backup.tar")
		}
		return exportDatabase(filepath.Join(temporary, "export.sock"), os.Args[2])
	}
	motelConfig, err := os.ReadFile(filepath.Join(runtime, "motel.capnp"))
	if err != nil {
		command.Process.Kill()
		<-stopped
		return err
	}
	motelConfigPath := filepath.Join(temporary, "motel.capnp")
	if err = os.WriteFile(motelConfigPath, bytes.ReplaceAll(motelConfig, []byte("@@RUNTIME@@"), []byte(strings.Trim(strconv.Quote(runtime), "\""))), 0600); err != nil {
		command.Process.Kill()
		<-stopped
		return err
	}
	forget, err := recordTelemetrySocket(directory, collector)
	if err != nil {
		command.Process.Kill()
		<-stopped
		return err
	}
	defer forget()
	stopMotel := supervise(func() *exec.Cmd {
		// A collector that exited leaves its socket file behind; the next one binds the same path.
		os.Remove(collector)
		command := exec.Command(filepath.Join(runtime, "workerd"), "serve", motelConfigPath, "-I/", "--experimental", "--directory-path=motel-data="+motel, "--socket-addr=motel=unix:"+collector)
		configureChild(command)
		command.Stdout = os.Stderr
		command.Stderr = os.Stderr
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + temporary}
		command.Dir = runtime
		return command
	}, time.Second, 30*time.Second, time.After)
	defer stopMotel()

	proxy := productProxy(filepath.Join(temporary, "product.sock"), workerdIdleTimeout)
	publicListener, err := net.Listen("tcp", net.JoinHostPort(setting("HOST", "0.0.0.0"), port))
	if err != nil {
		command.Process.Kill()
		<-stopped
		return err
	}
	public := &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second}
	defer public.Close()
	go func() { serverError <- public.Serve(publicListener) }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case err := <-stopped:
		return err
	case <-signals:
	case err := <-serverError:
		if !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "Native host stopped")
		}
	}
	command.Process.Signal(syscall.SIGTERM)
	select {
	case err := <-stopped:
		return err
	case <-time.After(15 * time.Second):
		command.Process.Kill()
		return <-stopped
	}
}

// workerd serves HTTP with kj's default HttpServerSettings; its pipelineTimeout
// closes a keep-alive connection after 5 seconds without a request.
const workerdIdleTimeout = 5 * time.Second

// The proxy closes pooled connections at half workerd's idle timeout, so it never
// sends a request on a connection workerd is closing. Go replays only requests
// that are safe to repeat, so losing that race failed POSTs such as workflow runs.

func productProxy(socket string, upstreamIdleTimeout time.Duration) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(&url.URL{Scheme: "http", Host: "product.internal"})
			request.Out.Host = request.In.Host
			address, _, err := net.SplitHostPort(request.In.RemoteAddr)
			if err != nil {
				address = request.In.RemoteAddr
			}
			request.Out.Header.Set("x-executor-client-ip", address)
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			},
			IdleConnTimeout: upstreamIdleTimeout / 2,
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// Until workerd listens, its socket is missing or refuses connections.
			if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
				http.Error(w, "Executor is starting", http.StatusServiceUnavailable)
				return
			}
			if r.Context().Err() == nil {
				fmt.Fprintln(os.Stderr, "Executor request failed:", r.Method, err)
			}
			http.Error(w, "Executor did not complete the request", http.StatusBadGateway)
		},
	}
}

// supervise keeps an auxiliary process running beside the product: it restarts the process
// after an exit, waiting from minDelay up to maxDelay between attempts, and the product never
// waits for it. A process that ran longer than maxDelay restarts after minDelay again. after
// starts each wait. The returned function stops the process and waits for it to exit.
func supervise(newCommand func() *exec.Cmd, minDelay, maxDelay time.Duration, after func(time.Duration) <-chan time.Time) func() {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		delay := minDelay
		for {
			command := newCommand()
			started := time.Now()
			if err := command.Start(); err != nil {
				fmt.Fprintln(os.Stderr, "Telemetry collector could not start:", err)
			} else {
				exited := make(chan struct{})
				go func() { command.Wait(); close(exited) }()
				select {
				case <-exited:
					fmt.Fprintln(os.Stderr, "Telemetry collector stopped; restarting")
				case <-done:
					command.Process.Signal(syscall.SIGTERM)
					select {
					case <-exited:
					case <-time.After(15 * time.Second):
						command.Process.Kill()
						<-exited
					}
					return
				}
			}
			if time.Since(started) > maxDelay {
				delay = minDelay
			}
			select {
			case <-after(delay):
			case <-done:
				return
			}
			delay = min(delay*2, maxDelay)
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(done) })
		<-finished
	}
}

func main() {
	mode := "serve"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	var err error
	switch mode {
	case "serve", "export":
		err = serve(mode)
	case "telemetry":
		err = queryTelemetry(os.Args[2:], os.Stdout)
	case "health":
		client := http.Client{Timeout: 4 * time.Second}
		var response *http.Response
		response, err = client.Get("http://127.0.0.1:" + setting("PORT", "4400") + "/health")
		if err == nil {
			response.Body.Close()
			if response.StatusCode != 200 {
				err = errors.New("Executor is not ready")
			}
		}
	default:
		err = errors.New("expected serve, export, health, or telemetry")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Executor:", err)
		os.Exit(1)
	}
}

// telemetryRecord names the file in the product volume that holds the serving host's collector
// socket path. Only the host holding the volume lock writes or removes it.
func telemetryRecord(directory string) string {
	return filepath.Join(directory, ".executor-telemetry")
}

// recordTelemetrySocket publishes the collector's socket path for `executor-host telemetry` in the
// same container. The returned function removes the record when the host stops.
func recordTelemetrySocket(directory, socket string) (func(), error) {
	record := telemetryRecord(directory)
	pending := record + ".tmp"
	if err := os.WriteFile(pending, []byte(socket), 0600); err != nil {
		return nil, err
	}
	if err := os.Rename(pending, record); err != nil {
		os.Remove(pending)
		return nil, err
	}
	return func() { os.Remove(record) }, nil
}

// queryTelemetry reads the bundled collector's API for an operator in the container, for example
// `executor-host telemetry '/api/traces?limit=20'`. It writes the response body to output.
func queryTelemetry(args []string, output io.Writer) error {
	if len(args) != 1 || !strings.HasPrefix(args[0], "/") {
		return errors.New("usage: executor-host telemetry '/api/traces?limit=20'")
	}
	directory, err := filepath.Abs(setting("EXECUTOR_DATA_DIR", "/app/data"))
	if err != nil {
		return err
	}
	// A host stopped without cleanup leaves a record of a socket nothing serves; dialing it fails.
	recorded, err := os.ReadFile(telemetryRecord(directory))
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("the telemetry collector is not running")
	}
	if err != nil {
		return err
	}
	socket := string(recorded)
	if !filepath.IsAbs(socket) {
		return errors.New(telemetryRecord(directory) + " does not name a socket")
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 30 * time.Second}
	response, err := client.Get("http://motel.internal" + args[0])
	if err != nil {
		return errors.New("the telemetry collector is not running")
	}
	defer response.Body.Close()
	if _, err = io.Copy(output, response.Body); err != nil {
		return err
	}
	if response.StatusCode != 200 {
		return fmt.Errorf("the telemetry collector answered %d", response.StatusCode)
	}
	return nil
}

// Publish a completed PostgreSQL archive without replacing an existing backup.
func exportDatabase(socket, destination string) error {
	deadline := time.Now().Add(30 * time.Second)
	for !exists(socket) {
		if time.Now().After(deadline) {
			return errors.New("export worker did not start")
		}
		time.Sleep(50 * time.Millisecond)
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 10 * time.Minute}
	response, err := client.Get("http://product.internal/export")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("content-type") != "application/x-tar" {
		return errors.New("database export failed")
	}
	file, err := os.CreateTemp(filepath.Dir(destination), ".executor-export-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = io.Copy(file, response.Body)
	}
	if err == nil {
		err = file.Sync()
	}
	closed := file.Close()
	if err != nil {
		return err
	}
	if closed != nil {
		return closed
	}
	if err = os.Link(file.Name(), destination); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
