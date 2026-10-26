#!/usr/bin/env bash
# Run only through a verified SSH connection to the Beget account.
set -euo pipefail
release_id=${1:?release SHA required}
mode=${2:?deploy or rollback required}
beget_ip=${3:?verified Beget IPv4 required}
[[ "$release_id" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$mode" == deploy || "$mode" == rollback ]] || exit 2
[[ "$beget_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
[[ $(id -un) == soulpab9 ]] || { echo 'Unexpected hosting account' >&2; exit 2; }
home_dir=$(cd -- "$HOME" && pwd -P)
root="$home_dir/04agtogether"
[[ -d "$root" && ! -L "$root" && $(cd -- "$root" && pwd -P) == "$root" ]] || exit 2
[[ $(cat "$root/.deployment-ready") == 'soulparadise/04agtogether' ]] || exit 2
for directory in incoming releases public_html; do
  [[ -d "$root/$directory" && ! -L "$root/$directory" ]] || exit 2
done
[[ ! -L "$root/.deploy.lock" ]] || exit 2
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is active' >&2; exit 1; }
grep -Fq "PassengerAppRoot \"$root\"" "$root/.htaccess" || exit 2
[[ -d "$root/tmp" && ! -L "$root/tmp" ]] || exit 2

valid_target() {
  [[ "$1" =~ ^releases/[a-f0-9]{40}$ ]] && [[ -d "$root/$1" && ! -L "$root/$1" ]]
}
old_target=''
if [[ -L "$root/current" ]]; then
  old_target=$(readlink "$root/current")
  valid_target "$old_target" || exit 2
elif [[ -e "$root/current" ]]; then
  echo 'Refusing to replace a real directory' >&2; exit 2
fi
[[ ! -e "$root/previous" || -L "$root/previous" ]] || exit 2
release_dir="$root/releases/$release_id"
if [[ "$mode" == deploy ]]; then
  # Each SHA gets an immutable directory. Failed uploads/extractions remain for diagnosis.
  [[ ! -e "$release_dir" && ! -L "$release_dir" ]] || { echo 'Release already exists; use rollback to reactivate' >&2; exit 2; }
  [[ -f "$root/incoming/$release_id.tgz" && ! -L "$root/incoming/$release_id.tgz" ]] || exit 2
  [[ -f "$root/incoming/$release_id.tgz.sha256" && ! -L "$root/incoming/$release_id.tgz.sha256" ]] || exit 2
  (cd -- "$root/incoming" && sha256sum -c "$release_id.tgz.sha256")
  mkdir -- "$release_dir"
  tar --extract --gzip --file "$root/incoming/$release_id.tgz" --directory "$release_dir" --no-same-owner --no-same-permissions
fi
valid_target "releases/$release_id" || exit 2
[[ -f "$release_dir/backend/app.js" && -f "$release_dir/frontend/index.html" ]] || exit 2
grep -Fq "\"release\":\"$release_id\"" "$release_dir/release.json" || exit 2
[[ ! -L "$release_dir/backend" && ! -L "$release_dir/backend/tmp" ]] || exit 2
mkdir -p -- "$release_dir/backend/tmp"

switch_current() {
  local target=$1 temporary="$root/.current-$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  valid_target "$target" || return 1
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$root/current"
  touch -- "$root/tmp/restart.txt"
}
healthy() {
  local wanted=$1
  for attempt in 1 2 3 4 5 6; do
    if curl --silent --show-error --fail --connect-timeout 5 --max-time 10 \
        --resolve "soulparadise.ru:443:$beget_ip" https://soulparadise.ru/api/health \
        | grep -Fq "\"release\":\"$wanted\""; then return 0; fi
    sleep 2
  done
  return 1
}
switch_current "releases/$release_id"
if ! healthy "$release_id"; then
  if [[ -n "$old_target" ]]; then
    switch_current "$old_target"
    healthy "${old_target#releases/}" || { echo 'Rollback health check failed' >&2; exit 1; }
    echo 'New release failed; previous release restored' >&2
  else
    echo 'First release failed; no previous release exists' >&2
  fi
  exit 1
fi
if [[ -n "$old_target" && "$old_target" != "releases/$release_id" ]]; then
  previous_temp="$root/.previous-$$"
  [[ ! -e "$previous_temp" && ! -L "$previous_temp" ]] || exit 2
  ln -s -- "$old_target" "$previous_temp"
  mv -Tf -- "$previous_temp" "$root/previous"
fi
echo "Active release: $release_id"
