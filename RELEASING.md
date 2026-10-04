# Releasing Mailtropy

Install Python 3 and [Gitleaks](https://github.com/gitleaks/gitleaks):

```sh
brew install gitleaks
```

Scan current files and all local Git history:

```sh
python3 scripts/release.py check
```

Build clean release and local-test packages:

```sh
python3 scripts/release.py build
```

Both commands stop on detected secrets. The build scans the staged package too.
Only the exact audited extension public key is allowlisted. Passwords, private
keys, and other tokens are not allowlisted. Scanners cannot guarantee that every
possible secret is detected.

The builder includes only the runtime files listed in `scripts/release.py`.
Add new runtime dependencies to that list when needed. Git history, documents,
scripts, metadata, and local credentials are excluded. `manifest.json` sits at
the ZIP root. Ignore rules alone do not make manually created ZIPs safe.

For v1.0.2, output files are:

- `dist/mailtropy-v1.0.2.zip`: upload this to Chrome Developer Console.
- `dist/mailtropy-v1.0.2-test.zip`: extract this to a fresh folder for local testing.
  It includes the public key that preserves the test extension ID.

Test in Chrome:

1. Disable the old Mailtropy copy to avoid confusion.
2. Open `chrome://extensions`, enable Developer mode, and load the extracted test folder.
3. Run **Analyze Mail Box** and confirm results and recommended actions appear.
4. Check authentication/reconnect, stopping a scan, and reopening the popup.
5. Inspect service-worker Network/Console for errors, then also test with DevTools
   closed; an open debugger can change the service worker's lifetime.

Before each store update, increment `version` in `manifest.json`, rebuild, and
test again. Upload the release ZIP to the existing Mailtropy listing, submit it
for review, and publish when approved. Follow the dashboard's current status;
the builder does not upload or publish anything.

Keep GitHub secret scanning and push protection enabled. Run `check` before
committing and `build` before each release. Do not commit generated ZIPs or
actual credential files. If a real secret is ever detected, revoke/rotate it
before addressing its history.
