package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
)

// workerdResponses serves fixed responses on a Unix socket, as workerd would.
func workerdResponses(t *testing.T, handler http.HandlerFunc) string {
	socket := socketPath(t)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	return socket
}

func compressingFront(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	front := httptest.NewServer(compressedHandler(productProxy(workerdResponses(t, handler), workerdIdleTimeout)))
	t.Cleanup(front.Close)
	return front
}

// rawGet requests without Go's transparent gzip decoding.
func rawGet(t *testing.T, url, acceptEncoding string) *http.Response {
	t.Helper()
	header := http.Header{}
	if acceptEncoding != "" {
		header.Set("Accept-Encoding", acceptEncoding)
	}
	return rawRequest(t, url, header)
}

// rawRequest sends a GET whose headers and body must arrive within a deadline, so a host that
// stops flushing fails the test instead of hanging it.
func rawRequest(t *testing.T, url string, header http.Header) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	request, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header = header
	response, err := (&http.Transport{DisableCompression: true}).RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func decoder(t *testing.T, response *http.Response) io.Reader {
	t.Helper()
	switch response.Header.Get("Content-Encoding") {
	case "br":
		return brotli.NewReader(response.Body)
	case "gzip":
		gz, err := gzip.NewReader(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return gz
	}
	return response.Body
}

func decoded(t *testing.T, response *http.Response) string {
	t.Helper()
	body, err := io.ReadAll(decoder(t, response))
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

// varies lists the response's Vary fields across every Vary header line.
func varies(response *http.Response) []string {
	var fields []string
	for _, value := range response.Header.Values("Vary") {
		for _, field := range strings.Split(value, ",") {
			fields = append(fields, strings.TrimSpace(field))
		}
	}
	return fields
}

func TestNegotiatesTheClientsPreferredEncoding(t *testing.T) {
	cases := map[string]string{
		"":                       "",
		"identity":               "",
		"gzip":                   "gzip",
		"gzip, deflate, br":      "br",
		"br;q=0, gzip":           "gzip",
		"gzip;q=1.0, br;q=0.5":   "gzip",
		"*":                      "br",
		"*;q=0.5, br;q=0":        "gzip",
		"GZIP;Q=0.8":             "gzip",
		"deflate, gzip;q=0":      "",
		"br;q=invalid, gzip;q=1": "gzip",
	}
	for header, want := range cases {
		if got := acceptedEncoding([]string{header}); got != want {
			t.Errorf("Accept-Encoding %q chose %q, want %q", header, got, want)
		}
	}
}

func TestCompressesTextAndLeavesOtherResponsesAlone(t *testing.T) {
	page := strings.Repeat("<p>Executor dashboard</p>", 200)
	front := compressingFront(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Length", "5000")
			w.Header().Set("ETag", `"v1"`)
			io.WriteString(w, page)
		case "/small":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"ok":true}`)
		case "/image":
			w.Header().Set("Content-Type", "image/png")
			io.WriteString(w, page)
		case "/encoded":
			w.Header().Set("Content-Type", "text/plain")
			w.Header().Set("Content-Encoding", "gzip")
			gz := gzip.NewWriter(w)
			io.WriteString(gz, page)
			gz.Close()
		case "/no-transform":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "private, no-transform")
			io.WriteString(w, page)
		}
	})

	for _, encoding := range []string{"br", "gzip"} {
		response := rawGet(t, front.URL+"/page", encoding)
		if got := response.Header.Get("Content-Encoding"); got != encoding {
			t.Fatalf("page with %s: Content-Encoding %q", encoding, got)
		}
		if response.Header.Get("Content-Length") != "" || response.Header.Get("Vary") != "Accept-Encoding" || response.Header.Get("ETag") != `W/"v1"` {
			t.Fatalf("page with %s: headers %v", encoding, response.Header)
		}
		if body := decoded(t, response); body != page {
			t.Fatalf("page with %s decoded to %d bytes", encoding, len(body))
		}
	}
	plain := rawGet(t, front.URL+"/page", "")
	if plain.Header.Get("Content-Encoding") != "" || plain.Header.Get("Vary") != "Accept-Encoding" || plain.Header.Get("Content-Length") != "5000" {
		t.Fatalf("page without Accept-Encoding: headers %v", plain.Header)
	}
	for _, path := range []string{"/small", "/image", "/no-transform"} {
		response := rawGet(t, front.URL+path, "br, gzip")
		if got := response.Header.Get("Content-Encoding"); got != "" {
			t.Fatalf("%s: Content-Encoding %q, want none", path, got)
		}
	}
	encoded := rawGet(t, front.URL+"/encoded", "br, gzip")
	if encoded.Header.Get("Content-Encoding") != "gzip" || decoded(t, encoded) != page {
		t.Fatalf("an already encoded response was encoded again: %v", encoded.Header)
	}
}

// A 304 must carry the Vary and ETag of the response it revalidates, or a cache that stored one
// encoding would serve it to clients that asked for another.
func TestConditionalResponsesKeepTheEncodingMetadata(t *testing.T) {
	page := strings.Repeat("<p>Executor dashboard</p>", 200)
	front := compressingFront(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Vary", "Cookie")
		w.Header().Set("ETag", `"v1"`)
		if match := r.Header.Get("If-None-Match"); strings.TrimPrefix(match, "W/") == `"v1"` {
			// Like the app asset server, the 304 names no Content-Type.
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, page)
	})

	steps := []struct {
		name, acceptEncoding, ifNoneMatch string
		status                            int
		encoding, etag                    string
	}{
		{"brotli GET", "br", "", http.StatusOK, "br", `W/"v1"`},
		{"brotli revalidation", "br", `W/"v1"`, http.StatusNotModified, "", `W/"v1"`},
		{"unencoded GET", "", "", http.StatusOK, "", `"v1"`},
		{"unencoded revalidation", "", `"v1"`, http.StatusNotModified, "", `"v1"`},
		{"gzip revalidation", "gzip", `"v1"`, http.StatusNotModified, "", `W/"v1"`},
	}
	for _, step := range steps {
		header := http.Header{}
		if step.acceptEncoding != "" {
			header.Set("Accept-Encoding", step.acceptEncoding)
		}
		if step.ifNoneMatch != "" {
			header.Set("If-None-Match", step.ifNoneMatch)
		}
		response := rawRequest(t, front.URL+"/page", header)
		if response.StatusCode != step.status || response.Header.Get("Content-Encoding") != step.encoding {
			t.Fatalf("%s: status %d, Content-Encoding %q", step.name, response.StatusCode, response.Header.Get("Content-Encoding"))
		}
		if got := strings.Join(varies(response), ", "); got != "Cookie, Accept-Encoding" {
			t.Fatalf("%s: Vary %q, want %q", step.name, got, "Cookie, Accept-Encoding")
		}
		if got := response.Header.Get("ETag"); got != step.etag {
			t.Fatalf("%s: ETag %q, want %q", step.name, got, step.etag)
		}
		if step.status == http.StatusOK && decoded(t, response) != page {
			t.Fatalf("%s: body did not decode to the page", step.name)
		}
	}
}

// Each streamed chunk must reach the client while the response is still open: the upstream
// sends the next chunk only after the client has received the previous one.
func TestEncodedStreamsDeliverEachChunkAsItArrives(t *testing.T) {
	chunks := []string{"first\n", "second\n", "third\n"}
	cases := []struct{ contentType, acceptEncoding, encoding string }{
		{"application/x-ndjson", "br", "br"},
		{"application/x-ndjson", "gzip", "gzip"},
		{"text/event-stream", "br, gzip", ""},
	}
	for _, c := range cases {
		t.Run(c.contentType+" with "+c.acceptEncoding, func(t *testing.T) {
			release := make(chan struct{})
			front := compressingFront(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", c.contentType)
				for index, chunk := range chunks {
					if index > 0 {
						select {
						case <-release:
						case <-r.Context().Done():
							return
						}
					}
					io.WriteString(w, chunk)
					w.(http.Flusher).Flush()
				}
			})

			response := rawGet(t, front.URL+"/stream", c.acceptEncoding)
			if got := response.Header.Get("Content-Encoding"); got != c.encoding {
				t.Fatalf("Content-Encoding %q, want %q", got, c.encoding)
			}
			reader := bufio.NewReader(decoder(t, response))
			lines := make(chan string, len(chunks)+1)
			go func() {
				defer close(lines)
				for {
					text, err := reader.ReadString('\n')
					if text != "" {
						lines <- text
					}
					if err != nil {
						return
					}
				}
			}()
			for index, chunk := range chunks {
				select {
				case text, open := <-lines:
					if !open || text != chunk {
						t.Fatalf("chunk %d: got %q, want %q", index, text, chunk)
					}
				case <-time.After(5 * time.Second):
					t.Fatalf("chunk %d did not arrive while the response was open", index)
				}
				if index < len(chunks)-1 {
					select {
					case release <- struct{}{}:
					case <-time.After(5 * time.Second):
						t.Fatalf("the upstream did not wait to send chunk %d", index+1)
					}
				}
			}
			select {
			case text, open := <-lines:
				if open {
					t.Fatalf("unexpected data after the last chunk: %q", text)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the response did not end after the last chunk")
			}
		})
	}
}

// A Git push streams through the public handler both ways: Git reads progress while it is still
// sending the pack. Git asks for gzip, but its pack responses stay unencoded, and each request
// chunk reaches the upstream only after the client has read the reply to the one before it.
func TestGitPushesStreamBothWaysUnencoded(t *testing.T) {
	chunks := []string{"pack-1\n", "pack-2\n", "pack-3\n"}
	received := make(chan string, 1)
	upstream := workerdResponses(t, func(w http.ResponseWriter, r *http.Request) {
		controller := http.NewResponseController(w)
		controller.EnableFullDuplex()
		w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "ready\n")
		controller.Flush()
		reader := bufio.NewReader(r.Body)
		var body strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if line != "" {
				body.WriteString(line)
				io.WriteString(w, "got "+line)
				controller.Flush()
			}
			if err != nil {
				break
			}
		}
		received <- body.String()
	})
	front := httptest.NewServer(publicHandler(productProxy(upstream, workerdIdleTimeout)))
	t.Cleanup(front.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	pack, sender := io.Pipe()
	// The transport reads the request body until it ends, even after the deadline cancels it.
	context.AfterFunc(ctx, func() { sender.CloseWithError(ctx.Err()) })
	request, err := http.NewRequestWithContext(ctx, "POST", front.URL+"/app.git/git-receive-pack", pack)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	request.Header.Set("Accept-Encoding", "deflate, gzip")
	response, err := (&http.Transport{DisableCompression: true}).RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding %q, want none", got)
	}
	lines := make(chan string, len(chunks)+2)
	go func() {
		defer close(lines)
		reader := bufio.NewReader(response.Body)
		for {
			text, err := reader.ReadString('\n')
			if text != "" {
				lines <- text
			}
			if err != nil {
				return
			}
		}
	}()
	next := func(want string) {
		t.Helper()
		select {
		case text := <-lines:
			if text != want {
				t.Fatalf("got %q, want %q", text, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%q did not arrive while the push was still sending", want)
		}
	}
	// A host that stops reading the request leaves a write blocked; the deadline fails it.
	send := func(chunk string) {
		t.Helper()
		written := make(chan error, 1)
		go func() {
			_, err := io.WriteString(sender, chunk)
			written <- err
		}()
		select {
		case err := <-written:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			sender.CloseWithError(errors.New("the host stopped reading the push"))
			t.Fatalf("%q was not read while the response was open", chunk)
		}
	}
	next("ready\n")
	for _, chunk := range chunks {
		send(chunk)
		next("got " + chunk)
	}
	sender.Close()
	select {
	case body := <-received:
		if body != strings.Join(chunks, "") {
			t.Fatalf("the upstream received %q", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the upstream did not receive the whole push")
	}
	select {
	case text, open := <-lines:
		if open {
			t.Fatalf("unexpected data after the push: %q", text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the response did not end after the push")
	}
}
