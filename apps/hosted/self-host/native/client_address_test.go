package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func mustTrust(t *testing.T, setting string) []netip.Prefix {
	t.Helper()
	proxies, err := trustedProxies(setting)
	if err != nil {
		t.Fatal(err)
	}
	return proxies
}

func TestTrustedProxiesAreAddressesAndRanges(t *testing.T) {
	proxies := mustTrust(t, " 10.6.0.0/16, 192.0.2.7 ,2001:db8::/32,, ::ffff:198.51.100.1, ::ffff:10.7.0.0/112")
	want := []string{"10.6.0.0/16", "192.0.2.7/32", "2001:db8::/32", "198.51.100.1/32", "10.7.0.0/16"}
	if len(proxies) != len(want) {
		t.Fatalf("got %v, want %v", proxies, want)
	}
	for i, prefix := range proxies {
		if prefix.String() != want[i] {
			t.Fatalf("got %v, want %v", proxies, want)
		}
	}
	if proxies := mustTrust(t, ""); len(proxies) != 0 {
		t.Fatalf("an empty setting trusts %v", proxies)
	}
	for _, invalid := range []string{"10.6.0.0/33", "proxy.internal", "10.6.0.0/16, *", "10.6.0.0/16;10.7.0.0/16"} {
		if _, err := trustedProxies(invalid); err == nil {
			t.Fatalf("%q was accepted", invalid)
		}
	}
}

func TestClientAddress(t *testing.T) {
	// Internet → load balancer → gateway → this host; both proxies are in 10.6.0.0/16.
	vpc := mustTrust(t, "10.6.0.0/16")
	cases := []struct {
		name         string
		peer         string
		forwardedFor []string
		trusted      []netip.Prefix
		want         string
	}{
		{"without trusted proxies the header is ignored", "10.6.41.10:51234", []string{"198.51.100.7"}, nil, "10.6.41.10"},
		{"an untrusted peer cannot name another client", "203.0.113.50:443", []string{"198.51.100.7"}, vpc, "203.0.113.50"},
		{"a trusted peer without the header is the client", "10.6.41.10:51234", nil, vpc, "10.6.41.10"},
		{"the load balancer's client, past the gateway and the load balancer", "10.6.41.10:51234", []string{"198.51.100.7, 10.6.100.5"}, vpc, "198.51.100.7"},
		{"what the client wrote itself is never read", "10.6.41.10:51234", []string{"203.0.113.9, 192.0.2.1, 198.51.100.7, 10.6.100.5"}, vpc, "198.51.100.7"},
		{"repeated header lines are one list, in order", "10.6.41.10:51234", []string{"203.0.113.9", "198.51.100.7", "10.6.100.5"}, vpc, "198.51.100.7"},
		{"a chain of trusted proxies only is its first address", "10.6.41.10:51234", []string{"10.6.7.8, 10.6.100.5"}, vpc, "10.6.7.8"},
		{"a value that is not an address stops at the proxy that added it", "10.6.41.10:51234", []string{"198.51.100.7, unknown, 10.6.100.5"}, vpc, "10.6.100.5"},
		{"an empty entry stops the walk too", "10.6.41.10:51234", []string{"198.51.100.7,, 10.6.100.5"}, vpc, "10.6.100.5"},
		{"a value that is not an address at the right leaves the peer", "10.6.41.10:51234", []string{"198.51.100.7, 10.6.100.5:"}, vpc, "10.6.41.10"},
		{"an empty header leaves the peer", "10.6.41.10:51234", []string{""}, vpc, "10.6.41.10"},
		{"entries with ports", "10.6.41.10:51234", []string{"198.51.100.7:4711, 10.6.100.5:443"}, vpc, "198.51.100.7"},
		{"an IPv4-mapped peer is its IPv4 address", "[::ffff:10.6.41.10]:51234", []string{"198.51.100.7"}, vpc, "198.51.100.7"},
		{"an IPv4-mapped range trusts its IPv4 addresses", "10.7.0.9:51234", []string{"198.51.100.7"}, mustTrust(t, "::ffff:10.7.0.0/112"), "198.51.100.7"},
		{"a long chain of trusted proxies", "10.6.41.10:51234", []string{strings.Repeat("10.6.0.1, ", 100000) + "10.6.100.5"}, vpc, "10.6.0.1"},
		{"IPv6 clients and proxies", "[2001:db8::10]:51234", []string{"2001:db8:ffff::1, [2001:db8::5]:443"}, mustTrust(t, "2001:db8::/48"), "2001:db8:ffff::1"},
		{"IPv6 zones do not make an address untrusted", "[fe80::1%eth0]:51234", []string{"198.51.100.7"}, mustTrust(t, "fe80::/10"), "198.51.100.7"},
		{"a peer that is not an address is kept as it is", "@", []string{"198.51.100.7"}, vpc, "@"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := clientAddress(c.peer, c.forwardedFor, c.trusted); got != c.want {
				t.Fatalf("clientAddress(%q, %q) = %q, want %q", c.peer, c.forwardedFor, got, c.want)
			}
		})
	}
}

// The product receives one client address, set by this host: a client's own x-executor-client-ip
// and forwarding headers never reach it.
func TestProxySendsTheProductOnlyTheClientAddress(t *testing.T) {
	received := make(chan http.Header, 1)
	socket := workerdResponses(t, func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
	})
	send := func(t *testing.T, trusted ...netip.Prefix) http.Header {
		t.Helper()
		front := httptest.NewServer(productProxy(socket, workerdIdleTimeout, trusted...))
		defer front.Close()
		request, err := http.NewRequest("GET", front.URL+"/api/auth/get-session", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("x-executor-client-ip", "192.0.2.66")
		request.Header.Add("X-Forwarded-For", "203.0.113.9, 198.51.100.7")
		request.Header.Add("X-Forwarded-For", "10.6.100.5")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return <-received
	}

	untrusted := send(t)
	if got := untrusted.Get("x-executor-client-ip"); got != "127.0.0.1" {
		t.Fatalf("without trusted proxies the client address is %q, want the peer 127.0.0.1", got)
	}
	behindProxies := send(t, mustTrust(t, "127.0.0.1, 10.6.0.0/16")...)
	if got := behindProxies.Get("x-executor-client-ip"); got != "198.51.100.7" {
		t.Fatalf("behind trusted proxies the client address is %q, want 198.51.100.7", got)
	}
	for _, header := range []http.Header{untrusted, behindProxies} {
		if values := header.Values("x-executor-client-ip"); len(values) != 1 {
			t.Fatalf("the product received x-executor-client-ip %q", values)
		}
		if values := header.Values("X-Forwarded-For"); len(values) != 0 {
			t.Fatalf("the product received X-Forwarded-For %q", values)
		}
	}
}
