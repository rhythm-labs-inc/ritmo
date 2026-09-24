# Move from AppRhythm to Ritmo

New projects use `ritmo.yaml`, `.ritmo/`, and `RITMO_*` settings. Existing AppRhythm projects and saved credentials remain supported. Both `ritmo` and `apprhythm` run the same CLI.

## Configuration and local state

**Keep your current setup, or rename it when convenient**

| Item | New name | Supported legacy name |
|---|---|---|
| Project configuration | `ritmo.yaml` | `apprhythm.yaml` |
| Identity and validation history | `.ritmo/` | `.apprhythm/` |
| Default metadata snapshot | `ritmo.manifest.json` | `apprhythm.manifest.json` |

If only the legacy name exists, Ritmo continues to use it for reads and writes. Configuration schema version 1 is unchanged. Ritmo reads the current folder; it does not search parent folders or use an unrelated `config.yaml`.

**Rename an existing project**

1. Stop running Ritmo processes and back up your project.
2. Rename `apprhythm.yaml` to `ritmo.yaml`, only if the new name does not already exist.
3. Rename `.apprhythm/` to `.ritmo/` under the same condition. Keep this directory gitignored.
4. Update any scripts that explicitly reference the old paths.

Ritmo does not combine configuration or state automatically. If both names exist, back up both, choose the version you want, and move the other outside the project before retrying. `init --force` does not bypass this check. State directories must be real directories, not symlinks.

For manifest snapshots, both names can be handled with an explicit `--out` when saving, or an explicit baseline argument when comparing. Historical report contents and identities are preserved.

## Environment precedence

**Use `RITMO_*` for new settings**

Each new variable takes precedence when present, even if empty. Only an absent variable falls back to its matching `APPRHYTHM_*` name.

| Setting suffix | Behaviour |
|---|---|
| `OPENAI_API_KEY` | Trimmed before use. An empty selected value falls through to the keychain, not the legacy environment key. |
| `SUBJECT` | CLI identity options take precedence, followed by the selected variable, then saved identity. |
| `NO_KEYCHAIN` | A nonempty value other than `0` or `false` disables keychain access; comparison is case-insensitive. |
| `NO_HISTORY` | Presence disables terminal validation history, including an empty value. |

For example, an empty `RITMO_NO_KEYCHAIN` overrides an older `APPRHYTHM_NO_KEYCHAIN=1` setting.

## Secure credential compatibility

**Existing logins stay available**

Ritmo reads the OS keychain service `ritmo` first, then `apprhythm` if the matching entry is absent. This applies to OpenAI keys, explicit keychain header references, and OAuth sessions. A keychain permission error is reported rather than bypassed.

New keys and refreshed OAuth sessions are written to `ritmo`. Existing legacy entries are preserved. Removing a key or clearing a login deletes the matching entry from both services, legacy first, so an old login cannot reappear after a successful clear. If removal fails, restore keychain access and retry.

OAuth sessions remain tied to the exact endpoint, account label, client, callback, and scope. Credentials are not combined or exported to plaintext. Environment-backed headers can work without a keychain; saved OAuth sessions require one.

**Roll back when needed**

Stop running processes and restore your backed-up names without overwriting another configuration or state directory. Older executables cannot read credentials saved only in `ritmo`, so you may need to sign in again. Existing credentials under `apprhythm` remain available to them.
