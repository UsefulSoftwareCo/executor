package main

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"os"
	"regexp"
	"strings"
)

// Only named TCP peers may assert the configured client-IP header. The private
// x-executor-client-ip header is always overwritten before workerd sees it.
type trustedProxy struct {
	header string
	peers  []netip.Prefix
}

func trustedProxyConfiguration() (*trustedProxy, error) {
	header := strings.ToLower(strings.TrimSpace(os.Getenv("EXECUTOR_TRUSTED_PROXY_HEADER")))
	peers := strings.TrimSpace(os.Getenv("EXECUTOR_TRUSTED_PROXIES"))
	if header == "" {
		return nil, nil
	}
	if peers == "" {
		return nil, errors.New("EXECUTOR_TRUSTED_PROXIES is required with EXECUTOR_TRUSTED_PROXY_HEADER")
	}
	if !regexp.MustCompile(`^[a-z0-9!#$%&'*+.^_|~\x60-]+$`).MatchString(header) || header == "x-executor-client-ip" {
		return nil, errors.New("EXECUTOR_TRUSTED_PROXY_HEADER must be a valid HTTP header other than x-executor-client-ip")
	}
	proxy := &trustedProxy{header: header}
	for _, value := range strings.Split(peers, ",") {
		value = strings.TrimSpace(value)
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			address, addressErr := netip.ParseAddr(value)
			if addressErr != nil || address.Zone() != "" {
				return nil, errors.New("EXECUTOR_TRUSTED_PROXIES must contain comma-separated IP addresses or CIDR ranges")
			}
			address = address.Unmap()
			prefix = netip.PrefixFrom(address, address.BitLen())
		}
		if prefix.Addr().Zone() != "" || prefix.Addr().Is4In6() {
			return nil, errors.New("EXECUTOR_TRUSTED_PROXIES must use native IPv4 or IPv6 CIDR ranges")
		}
		proxy.peers = append(proxy.peers, prefix.Masked())
	}
	return proxy, nil
}

func (p *trustedProxy) trusts(address netip.Addr) bool {
	for _, prefix := range p.peers {
		if prefix.Contains(address.Unmap()) {
			return true
		}
	}
	return false
}

func (p *trustedProxy) clientIP(request *http.Request) string {
	peer, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		peer = request.RemoteAddr
	}
	address, err := netip.ParseAddr(peer)
	if err != nil {
		return peer
	}
	peer = address.Unmap().String()
	if p == nil || !p.trusts(address) {
		return peer
	}
	values := request.Header.Values(p.header)
	if len(values) != 1 {
		return peer
	}
	chain := strings.Split(values[0], ",")
	if p.header != "x-forwarded-for" && len(chain) != 1 {
		return peer
	}
	addresses := make([]netip.Addr, len(chain))
	for index, value := range chain {
		parsed, err := netip.ParseAddr(strings.TrimSpace(value))
		if err != nil || parsed.Zone() != "" {
			return peer
		}
		addresses[index] = parsed.Unmap()
	}
	// A single-IP header is replaced by the trusted proxy. X-Forwarded-For
	// is a chain: discard only trusted hops from its right, never an untrusted
	// caller's leftmost assertion. If every hop is trusted, use the socket peer.
	if p.header != "x-forwarded-for" {
		return addresses[0].String()
	}
	for index := len(addresses) - 1; index >= 0; index-- {
		if !p.trusts(addresses[index]) {
			return addresses[index].String()
		}
	}
	return peer
}
