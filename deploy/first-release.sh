#!/usr/bin/env bash
# Run only AFTER separate user approval and verification of this site's runtime.
set -euo pipefail
source '/home/s/soulpab9/04agtogether/deploy/site-lib.sh'
checked_site; lock_site
sha=${1:?release SHA required}; ip=${2:?verified IP required}
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$ip" == 45.130.41.94 ]] || exit 2
[[ ! -e "$root/current" && ! -L "$root/current" ]] || exit 2
for name in public_html incoming releases tmp deploy; do checked_directory "$root/$name"; done
config="$root/deploy/site.htaccess.ready"
[[ -f "$config" && ! -L "$config" ]] || exit 2
grep -Fq "PassengerAppRoot \"$root\"" "$config"
! grep -Eq '__[A-Z_]+__|^[[:space:]]*Passenger(MaxPoolSize|MaxInstancesPerApp)[[:space:]]' "$config"
release_runtime "$config"
archive="$root/incoming/$sha.tgz"
[[ -f "$archive" && ! -L "$archive" && ! -L "$archive.sha256" ]] || exit 2
(cd -- "$root/incoming" && sha256sum -c --status "$sha.tgz.sha256")
validate_archive "$archive" release
release_dir="$root/releases/$sha"
if [[ ! -e "$release_dir" && ! -L "$release_dir" ]]; then
  mkdir -- "$release_dir"
  tar -xzf "$archive" -C "$release_dir" --no-same-owner --no-same-permissions
fi
verify_release "$release_dir" "$sha"
bash "$root/deploy/backup-static.sh"
restore_needed=true
failed_first() {
  local status=$?
  if [[ "$restore_needed" == true ]]; then
    source "$root/deploy/restore-static.sh"
    restore_static_main || echo 'STATIC RESTORE FAILED: use the preserved snapshot before further deployment' >&2
  fi
  exit "$status"
}
trap failed_first EXIT
backup_id=$(cat "$root/.static-backup")
backup="$root/backups/$backup_id"
mkdir -- "$backup/new-public_html"
# Preserve ACME files without editing certificates, DNS or hosting SSL settings.
if [[ -d "$root/public_html/.well-known" ]]; then cp -a -- "$root/public_html/.well-known" "$backup/new-public_html/.well-known"; fi
ln -s -- "releases/$sha" "$root/.current-$$"
mv -T -- "$root/.current-$$" "$root/current"
cp -- "$root/deploy/app.js" "$root/.app-$$"; mv -T -- "$root/.app-$$" "$root/app.js"
mv -T -- "$root/public_html" "$backup/prelaunch-public_html"
mv -T -- "$backup/new-public_html" "$root/public_html"
cp -- "$config" "$root/.htaccess-$$"; mv -T -- "$root/.htaccess-$$" "$root/.htaccess"
touch -- "$root/tmp/restart.txt"
# Startup may take time; only this application is restarted.
ready=false
for attempt in 1 2 3 4 5 6; do
  if curl -fsS --connect-timeout 5 --max-time 10 --resolve "soulparadise.ru:443:$ip" https://soulparadise.ru/api/health | grep -Fq "\"release\":\"$sha\""; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
live_release_check "$sha" "$ip"
restore_needed=false
echo "First release active: $sha. Static snapshot retained: $backup_id"
