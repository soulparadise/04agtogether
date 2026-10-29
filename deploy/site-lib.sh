#!/usr/bin/env bash
# All hosting writes are confined to this exact application, never a sibling.
checked_site() {
  root='/home/s/soulpab9/04agtogether'
  [[ $(id -un) == soulpab9 && -d "$root" && ! -L "$root" && $(cd -- "$root" && pwd -P) == "$root" ]] || return 2
  [[ -f "$root/.deployment-ready" && ! -L "$root/.deployment-ready" && $(cat "$root/.deployment-ready") == 'soulparadise/04agtogether' ]] || return 2
}
checked_directory() { [[ -d "$1" && ! -L "$1" && $(cd -- "$1" && pwd -P) == "$1" ]]; }
lock_site() {
  [[ ! -L "$root/.deploy.lock" ]] || return 2
  if [[ $(readlink "/proc/$$/fd/9" 2>/dev/null || true) != "$root/.deploy.lock" ]]; then exec 9>>"$root/.deploy.lock"; fi
  flock -n 9 || { echo 'Another 04agtogether operation is active' >&2; return 1; }
}
validate_archive() {
  local archive=$1 kind=$2 name listing types
  # Reject links/devices before extraction; reject escaped names and traversal.
  listing=$(tar -tzf "$archive" --quoting-style=escape) || return 2
  types=$(tar -tvzf "$archive" --quoting-style=escape) || return 2
  if grep -qv '^[d-]' <<< "$types"; then return 2; fi
  while IFS= read -r name; do
    name=${name#./}
    [[ -n "$name" && "$name" != /* && "$name" != *\\* && ! "$name" =~ (^|/)\.\.(/|$) ]] || return 2
    if [[ "$kind" == release ]]; then
      [[ "$name" =~ ^(frontend|backend|tools)(/|$) || "$name" == release.json ]] || return 2
    else
      [[ "$name" =~ ^public_html(/|$) || "$name" == .htaccess || "$name" == app.js ]] || return 2
    fi
  done <<< "$listing"
}
release_runtime() {
  local config=$1
  node_bin=$(sed -n 's/^PassengerNodejs "\([^"]*\)"$/\1/p' "$config")
  [[ "$node_bin" =~ ^/[a-zA-Z0-9_./-]+$ && -x "$node_bin" ]] || { echo 'Verify the site-specific Node binary first' >&2; return 2; }
  "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a!==24||b<15)process.exit(2)'
}
verify_release() {
  local release_dir=$1 sha=$2
  checked_directory "$release_dir" && checked_directory "$release_dir/backend" && checked_directory "$release_dir/frontend" && checked_directory "$release_dir/tools" || return 2
  [[ -f "$release_dir/backend/app.js" && -f "$release_dir/frontend/index.html" && -f "$release_dir/tools/check.cjs" ]] || return 2
  [[ -z $(find "$release_dir" -type l -print -quit) ]] || return 2
  grep -Fq "\"release\":\"$sha\"" "$release_dir/release.json"
}
live_release_check() {
  local sha=$1 ip=$2
  "$node_bin" "$root/releases/$sha/tools/check.cjs" https://soulparadise.ru "$sha" "$ip"
}
