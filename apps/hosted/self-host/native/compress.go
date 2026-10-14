package main

import (
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/andybalholm/brotli"
)

// The host compresses responses so workerd's single thread never spends time on it.
// The proxy sets a response's final headers before its body, so the choice is made once,
// in WriteHeader, without buffering: streamed bodies keep streaming, and every proxy
// flush also flushes the encoder.

// Below this size, a known-length body saves too little to be worth encoding.
const minimumCompressedSize = 1024

// Brotli quality 5 is about 11% smaller than gzip's default for the dashboard's scripts
// at similar CPU cost; higher qualities cost much more for a few percent.
const brotliQuality = 5

type encoder interface {
	io.WriteCloser
	Flush() error
	Reset(io.Writer)
}

var encoders = map[string]*sync.Pool{
	"br": {New: func() any { return brotli.NewWriterLevel(nil, brotliQuality) }},
	"gzip": {New: func() any {
		writer, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression)
		return writer
	}},
}

// compressedHandler encodes eligible responses with the client's preferred accepted encoding.
func compressedHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writer := &compressWriter{ResponseWriter: w, encoding: acceptedEncoding(r.Header.Values("Accept-Encoding")), head: r.Method == http.MethodHead}
		next.ServeHTTP(writer, r)
		// Not deferred: an aborted response gets no encoder trailer, and its encoder is dropped.
		writer.close()
	})
}

// acceptedEncoding returns "br", "gzip" or "" for the client's highest-weighted accepted encoding.
// Ties prefer brotli, which is smaller.
func acceptedEncoding(headers []string) string {
	weights := map[string]float64{}
	wildcard := -1.0
	for _, header := range headers {
		for _, entry := range strings.Split(header, ",") {
			name, parameters, _ := strings.Cut(entry, ";")
			name = strings.ToLower(strings.TrimSpace(name))
			weight := 1.0
			for _, parameter := range strings.Split(parameters, ";") {
				key, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
				if found && strings.EqualFold(strings.TrimSpace(key), "q") {
					parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
					if err != nil || parsed < 0 || parsed > 1 {
						parsed = 0
					}
					weight = parsed
				}
			}
			if name == "*" {
				wildcard = weight
			} else {
				weights[name] = weight
			}
		}
	}
	choice, best := "", 0.0
	for _, name := range []string{"br", "gzip"} {
		weight, listed := weights[name]
		if !listed {
			weight = max(wildcard, 0)
		}
		if weight > best {
			choice, best = name, weight
		}
	}
	return choice
}

// Text formats compress well; images, fonts and archives are already compressed.
// Server-sent events stay unencoded: MCP clients and browsers read each event as it
// arrives, and intermediaries may buffer an encoded event stream.
func compressibleType(header string) bool {
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	switch {
	case media == "text/event-stream":
		return false
	case strings.HasPrefix(media, "text/"):
		return true
	case strings.HasSuffix(media, "+json"), strings.HasSuffix(media, "+xml"):
		return true
	}
	switch media {
	case "application/json", "application/x-ndjson", "application/javascript", "application/xml", "application/wasm", "image/svg+xml":
		return true
	}
	return false
}

type compressWriter struct {
	http.ResponseWriter
	encoding string
	head     bool
	decided  bool
	encoder  encoder
}

func (w *compressWriter) WriteHeader(status int) {
	if w.decided {
		return
	}
	// Informational responses precede the final one, whose headers decide the encoding.
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.decided = true
	header := w.Header()
	// A 304 must carry the Vary and ETag its full response would. It usually has no Content-Type,
	// so an untyped 304 is treated as a compressible representation: an extra Vary only costs
	// cache hits, and a weakened ETag still matches If-None-Match, while a missing Vary lets a
	// cache serve one encoding to a client that asked for another.
	notModified := status == http.StatusNotModified
	contentType := header.Get("Content-Type")
	varies := status != http.StatusNoContent && status != http.StatusPartialContent &&
		header.Get("Content-Encoding") == "" &&
		!strings.Contains(strings.ToLower(header.Get("Cache-Control")), "no-transform") &&
		(compressibleType(contentType) || notModified && contentType == "")
	if length, err := strconv.ParseInt(header.Get("Content-Length"), 10, 64); err == nil && length < minimumCompressedSize {
		varies = false
	}
	if varies {
		// The representation depends on Accept-Encoding even for clients that receive it unencoded.
		vary := false
		for _, value := range header.Values("Vary") {
			for _, field := range strings.Split(value, ",") {
				field = strings.TrimSpace(field)
				vary = vary || field == "*" || strings.EqualFold(field, "Accept-Encoding")
			}
		}
		if !vary {
			header.Add("Vary", "Accept-Encoding")
		}
	}
	if varies && w.encoding != "" {
		// The encoded bytes differ from the validator's representation.
		if etag := header.Get("ETag"); etag != "" && !strings.HasPrefix(etag, "W/") {
			header.Set("ETag", "W/"+etag)
		}
		if !notModified {
			header.Set("Content-Encoding", w.encoding)
			header.Del("Content-Length")
			header.Del("Accept-Ranges")
			if !w.head {
				w.encoder = encoders[w.encoding].Get().(encoder)
				w.encoder.Reset(w.ResponseWriter)
			}
		}
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *compressWriter) Write(data []byte) (int, error) {
	if !w.decided {
		w.WriteHeader(http.StatusOK)
	}
	if w.encoder == nil {
		return w.ResponseWriter.Write(data)
	}
	return w.encoder.Write(data)
}

// FlushError lets the proxy push each streamed chunk to the client as it arrives.
func (w *compressWriter) FlushError() error {
	if w.encoder != nil {
		if err := w.encoder.Flush(); err != nil {
			return err
		}
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}

// Unwrap exposes the connection for upgrades through http.ResponseController.
func (w *compressWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *compressWriter) close() {
	if w.encoder == nil {
		return
	}
	w.encoder.Close()
	w.encoder.Reset(nil)
	encoders[w.encoding].Put(w.encoder)
	w.encoder = nil
}
