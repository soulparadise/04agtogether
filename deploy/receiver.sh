#!/usr/bin/env bash
# Forced command for the dedicated 04agtogether deployment SSH key.
# Never eval SSH_ORIGINAL_COMMAND or allow an arbitrary remote command.
set -euo pipefail
[[ $(id -un) == soulpab9 ]] || exit 2
home_dir=$(cd -- "$HOME" && pwd -P)
root="$home_dir/04agtogether"
[[ -d "$root" && ! -L "$root" && $(cd -- "$root" && pwd -P) == "$root" ]] || exit 2
[[ $(cat "$root/.deployment-ready") == 'soulparadise/04agtogether' ]] || exit 2
if [[ ${SSH_ORIGINAL_COMMAND:-} == restore-static ]]; then exec bash "$root/deploy/restore-static.sh"; fi
IFS=' ' read -r verb sha argument_a argument_b extra <<< "${SSH_ORIGINAL_COMMAND:-}"
[[ "$sha" =~ ^[a-f0-9]{40}$ && -z "$extra" ]] || exit 2
case "$verb" in
  upload)
    [[ "$argument_a" =~ ^[a-f0-9]{64}$ && -z "$argument_b" ]] || exit 2
    [[ -d "$root/incoming" && ! -L "$root/incoming" ]] || exit 2
    [[ ! -e "$root/incoming/$sha.tgz" && ! -L "$root/incoming/$sha.tgz" ]] || exit 2
    [[ ! -e "$root/incoming/$sha.tgz.sha256" && ! -L "$root/incoming/$sha.tgz.sha256" ]] || exit 2
    umask 077
    # noclobber also protects the file between the existence check and creation.
    set -o noclobber
    cat > "$root/incoming/$sha.tgz"
    printf '%s  %s.tgz\n' "$argument_a" "$sha" > "$root/incoming/$sha.tgz.sha256"
    (cd -- "$root/incoming" && sha256sum -c "$sha.tgz.sha256")
    ;;
  activate)
    [[ "$argument_a" == deploy || "$argument_a" == rollback || "$argument_a" == first ]] || exit 2
    [[ "$argument_b" == '45.130.41.94' ]] || exit 2
    if [[ "$argument_a" == first ]]; then exec bash "$root/deploy/first-release.sh" "$sha" "$argument_b"; fi
    exec bash "$root/deploy/activate.sh" "$sha" "$argument_a" "$argument_b"
    ;;
  *) echo 'Only 04agtogether upload/activate commands are allowed' >&2; exit 2 ;;
esac
