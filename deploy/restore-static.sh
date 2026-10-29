#!/usr/bin/env bash
restore_static_main() {
  source '/home/s/soulpab9/04agtogether/deploy/site-lib.sh'
  checked_site && lock_site || return 2
  local backup_id directory staging rescue name
  [[ -f "$root/.static-backup" && ! -L "$root/.static-backup" ]] || return 2
  backup_id=$(cat "$root/.static-backup")
  [[ "$backup_id" =~ ^initial-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || return 2
  directory="$root/backups/$backup_id"
  checked_directory "$root/backups" && checked_directory "$directory" || return 2
  [[ -f "$directory/static.tgz" && ! -L "$directory/static.tgz" && ! -L "$directory/static.tgz.sha256" ]] || return 2
  (cd -- "$directory" && sha256sum -c --status static.tgz.sha256) || return 2
  validate_archive "$directory/static.tgz" static || return 2
  # Validate all targets before moving anything. No recursive deletion is used.
  for name in public_html .htaccess app.js; do [[ ! -L "$root/$name" ]] || return 2; done
  if [[ -e "$root/current" || -L "$root/current" ]]; then
    [[ -L "$root/current" && $(readlink "$root/current") =~ ^releases/[a-f0-9]{40}$ ]] || return 2
  fi
  umask 077
  staging="$directory/restore-$(date -u +%Y%m%dT%H%M%SZ)-$$"; mkdir -- "$staging" || return 1
  tar -xzf "$directory/static.tgz" -C "$staging" --no-same-owner --no-same-permissions || return 1
  checked_directory "$staging/public_html" || return 2
  if [[ -d "$root/public_html/.well-known" ]]; then
    [[ ! -L "$root/public_html/.well-known" && -z $(find "$root/public_html/.well-known" -type l -print -quit) ]] || return 2
    cp -a -- "$root/public_html/.well-known" "$staging/public_html/" || return 1
  fi
  rescue="$staging/displaced"; mkdir -- "$rescue" || return 1
  for name in .htaccess app.js public_html current; do
    if [[ -e "$root/$name" || -L "$root/$name" ]]; then mv -T -- "$root/$name" "$rescue/$name" || return 1; fi
  done
  for name in public_html app.js .htaccess; do
    if [[ -e "$staging/$name" ]]; then mv -T -- "$staging/$name" "$root/$name" || return 1; fi
  done
  if checked_directory "$root/tmp"; then touch -- "$root/tmp/restart.txt"; fi
  diff -qr --exclude=.well-known -- "$directory/verified/public_html" "$root/public_html" || return 1
  echo "Restored static snapshot: $backup_id"
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then set -euo pipefail; restore_static_main; fi
