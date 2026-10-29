#!/usr/bin/env bash
set -euo pipefail
source '/home/s/soulpab9/04agtogether/deploy/site-lib.sh'
checked_site; lock_site
[[ ! -e "$root/current" && ! -L "$root/current" ]] || { echo 'Static backup is only for the initial installation' >&2; exit 2; }
checked_directory "$root/public_html"
[[ -z $(find "$root/public_html" -type l -print -quit) ]] || exit 2
umask 077
[[ ! -L "$root/backups" && ! -L "$root/.static-backup" ]] || exit 2
mkdir -p -- "$root/backups"; checked_directory "$root/backups"
backup_id="initial-$(date -u +%Y%m%dT%H%M%SZ)-$$"
directory="$root/backups/$backup_id"; mkdir -- "$directory"
entries=(public_html)
for name in .htaccess app.js; do
  [[ ! -L "$root/$name" ]] || exit 2
  if [[ -e "$root/$name" ]]; then [[ -f "$root/$name" ]] || exit 2; entries+=("$name"); fi
done
tar -czf "$directory/static.tgz" -C "$root" -- "${entries[@]}"
validate_archive "$directory/static.tgz" static
(cd -- "$directory" && sha256sum static.tgz > static.tgz.sha256 && sha256sum -c --status static.tgz.sha256)
# Rehearse extraction and compare content before changing any live entry point.
mkdir -- "$directory/verified"
tar -xzf "$directory/static.tgz" -C "$directory/verified" --no-same-owner --no-same-permissions
for name in "${entries[@]}"; do diff -qr -- "$root/$name" "$directory/verified/$name"; done
printf '%s\n' "$backup_id" > "$root/.static-backup-$$"
mv -T -- "$root/.static-backup-$$" "$root/.static-backup"
echo "$backup_id"
