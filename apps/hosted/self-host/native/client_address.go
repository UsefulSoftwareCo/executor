package main

import (
	"errors"
	"net"
	"net/netip"
	"strings"
)

// trustedProxies reads EXECUTOR_TRUSTED_PROXIES: comma-separated IP addresses or CIDR ranges of the
// proxies in front of this host, such as a load balancer and the gateway behind it. Empty trusts none.
func trustedProxies(setting string) ([]netip.Prefix, error) {
	proxies := []netip.Prefix{}
	for _, entry := range strings.Split(setting, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if prefix, err := netip.ParsePrefix(entry); err == nil {
			// Addresses are compared unmapped, so an IPv4-mapped range is its IPv4 range.
			if prefix.Addr().Is4In6() && prefix.Bits() >= 96 {
				prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
			}
			proxies = append(proxies, prefix.Masked())
			continue
		}
		address, err := netip.ParseAddr(entry)
		if err != nil {
			return nil, errors.New("EXECUTOR_TRUSTED_PROXIES must be comma-separated IP addresses or CIDR ranges")
		}
		proxies = append(proxies, netip.PrefixFrom(address.Unmap(), address.Unmap().BitLen()))
	}
	return proxies, nil
}

// clientAddress is the address a request comes from: the socket's peer, unless the peer is a trusted
// proxy. Each proxy appends the address it received the request from to X-Forwarded-For, so behind
// trusted proxies the header is read from the right, past every trusted proxy, to the first address
// that is not one: the client. What lies left of it the client sent itself, and anyone can forge it.
// A value that is not an address stops the walk at the proxy that added it. Without trusted proxies,
// or from any other peer, the header is ignored.
func clientAddress(remoteAddr string, forwardedFor []string, trusted []netip.Prefix) string {
	client, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		client = remoteAddr
	}
	peer, err := netip.ParseAddr(client)
	if err != nil || !isTrusted(peer, trusted) {
		return client
	}
	// Repeated header lines are one list, in order: the last line, from its right, comes first.
	for line := len(forwardedFor) - 1; line >= 0; line-- {
		rest := forwardedFor[line]
		for {
			comma := strings.LastIndexByte(rest, ',')
			hop, ok := forwardedAddress(rest[comma+1:])
			if !ok {
				return client
			}
			client = hop.String()
			if !isTrusted(hop, trusted) {
				return client
			}
			if comma < 0 {
				break
			}
			rest = rest[:comma]
		}
	}
	return client
}

func isTrusted(address netip.Addr, trusted []netip.Prefix) bool {
	address = address.WithZone("").Unmap()
	for _, prefix := range trusted {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

// forwardedAddress reads one X-Forwarded-For entry: an IP address, with a port or without.
func forwardedAddress(entry string) (netip.Addr, bool) {
	entry = strings.TrimSpace(entry)
	address, err := netip.ParseAddr(entry)
	if err != nil {
		withPort, err := netip.ParseAddrPort(entry)
		if err != nil {
			return netip.Addr{}, false
		}
		address = withPort.Addr()
	}
	return address.WithZone("").Unmap(), true
}
