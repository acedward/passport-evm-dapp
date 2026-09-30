#!/bin/sh
# MN Bank web: write the runtime configuration from the environment, then run nginx.
#
#   WEB_NETWORK                  stagenet (default) or undeployed: the network profile the site uses
#   WEB_RELAY_URL                the relay's base URL as the browser sees it (default /relay, the
#                                same-origin proxy below); an absolute https URL for a separate host
#   WEB_RELAY_UPSTREAM           where nginx reaches the relay (default relay:8080)
#   WEB_TRUSTED_PROXIES          addresses whose X-Forwarded-For nginx believes (comma-separated
#                                CIDRs): the reverse proxy in front, so the relay's rate limits key
#                                on each customer and not on the proxy
#   WEB_DNS_RESOLVER             DNS for the relay's name (default 127.0.0.11, Docker's)
#   WEB_CONTENT_SECURITY_POLICY  optional Content-Security-Policy header value
#   WEB_ASSETS                   this site's asset set: comma-separated symbols (for example
#                                USDC,TB13W,TB26W,TB52W), or "all"; empty: the network's
#                                default set (stagenet: USDC, stkA, stkB, stkC). Written into
#                                config.json as "assets"; one image serves every domain
#
# A full site configuration can be mounted at /etc/mnbank/config.json instead (for example with
# network overrides, a token list or "assets"); it is then served as is, and WEB_ASSETS is ignored.
set -eu

D=/tmp/mnbank
fail() {
  echo "mnbank-web: $*" >&2
  exit 78
}

network="${WEB_NETWORK:-stagenet}"
relay_url="${WEB_RELAY_URL:-/relay}"
upstream="${WEB_RELAY_UPSTREAM:-relay:8080}"
resolver="${WEB_DNS_RESOLVER:-127.0.0.11}"
trusted="${WEB_TRUSTED_PROXIES:-}"
csp="${WEB_CONTENT_SECURITY_POLICY:-}"
assets="${WEB_ASSETS:-}"

case "$network" in stagenet | undeployed) ;; *) fail "WEB_NETWORK must be stagenet or undeployed" ;; esac
case "$relay_url" in *'"'* | *'\'* | *' '*) fail "WEB_RELAY_URL must not contain quotes, backslashes or spaces" ;; esac
echo "$upstream" | grep -Eq '^[A-Za-z0-9._-]+:[0-9]{1,5}$' || fail "WEB_RELAY_UPSTREAM must be host:port"
echo "$resolver" | grep -Eq '^[0-9A-Fa-f.:]+$' || fail "WEB_DNS_RESOLVER must be an IP address"
case "$csp" in *'"'* | *'\'* | *'$'*) fail "WEB_CONTENT_SECURITY_POLICY must not contain quotes, backslashes or \$" ;; esac

# WEB_ASSETS -> the JSON value of "assets" (empty: no key, the network's default set). Each symbol
# follows the page's own rule (letters, digits, . _ -; 1 to 16 characters), at most 32 of them.
assets_json=""
if [ -n "$(echo "$assets" | tr -d ' ,')" ]; then
  if [ "$(echo "$assets" | tr -d ' ' | tr 'A-Z' 'a-z')" = all ]; then
    assets_json='"all"'
  else
    set -f
    n=0
    for sym in $(echo "$assets" | tr ',' ' '); do
      echo "$sym" | grep -Eq '^[A-Za-z0-9._-]{1,16}$' ||
        fail "WEB_ASSETS: '$sym' is not a symbol (letters, digits, . _ -; up to 16 characters)"
      n=$((n + 1))
      assets_json="$assets_json${assets_json:+,}\"$sym\""
    done
    set +f
    [ "$n" -le 32 ] || fail "WEB_ASSETS names $n symbols (at most 32)"
    assets_json="[$assets_json]"
  fi
fi

mkdir -p "$D" /tmp/client_body /tmp/proxy /tmp/fastcgi /tmp/uwsgi /tmp/scgi

assets_log="${assets_json:-the network default}"
if [ -f /etc/mnbank/config.json ]; then
  cp /etc/mnbank/config.json "$D/config.json"
  [ -z "$assets_json" ] || echo "mnbank-web: WEB_ASSETS is ignored: the mounted config.json is served as is" >&2
  assets_log="as the mounted config.json says"
elif [ -n "$assets_json" ]; then
  printf '{"network":"%s","relayUrl":"%s","assets":%s}\n' "$network" "$relay_url" "$assets_json" >"$D/config.json"
else
  printf '{"network":"%s","relayUrl":"%s"}\n' "$network" "$relay_url" >"$D/config.json"
fi

{
  echo "resolver $resolver valid=10s ipv6=off;"
  echo "resolver_timeout 5s;"
  echo "map \$host \$relay_upstream { default \"http://$upstream\"; }"
  found=0
  for cidr in $(echo "$trusted" | tr ',' ' '); do
    echo "$cidr" | grep -Eq '^[0-9A-Fa-f.:]+(/[0-9]{1,3})?$' || fail "WEB_TRUSTED_PROXIES: '$cidr' is not an address or CIDR"
    echo "set_real_ip_from $cidr;"
    found=1
  done
  if [ "$found" = 1 ]; then
    echo "real_ip_header X-Forwarded-For;"
    echo "real_ip_recursive on;"
  fi
} >"$D/http.conf"

if [ -n "$csp" ]; then
  echo "add_header Content-Security-Policy \"$csp\" always;" >"$D/headers.conf"
else
  : >"$D/headers.conf"
fi

echo "mnbank-web: network $network, relay $relay_url (upstream $upstream), trusted proxies: ${trusted:-none}, assets: $assets_log" >&2
exec nginx -g 'daemon off;'
