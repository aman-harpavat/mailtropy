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

For v1.0.3, output files are:

- `dist/mailtropy-v1.0.3.zip`: upload this to Chrome Developer Console.
- `dist/mailtropy-v1.0.3-test.zip`: extract this to a fresh folder for local testing.
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

## Development and scan progress testing

For day-to-day changes, load this project folder using **Load unpacked** in
`chrome://extensions`. Click **Reload** after edits and reopen the popup. A ZIP
is not needed for each change. The source manifest includes the same audited
public key as the test package, preserving extension ID
`oibgpcheneijkddgoembmkphkmaiohbd` for Gmail OAuth. The release builder removes
this field from store packages. After adding/changing the key, remove the old
unpacked copy and load this folder again so Chrome uses the correct ID.

Run the deterministic checks:

```sh
node scripts/test-scan-progress.mjs
```

The loading card now counts the scan workload before fetching metadata. It
shows scanned emails, then an approximate ETA range once measured throughput
is stable. An ETA can appear after ten seconds when speed is particularly
consistent; otherwise the normal twenty-second warm-up applies, and unstable
speeds can delay it further. Early ranges use a wider margin. Retries reset
the estimate. The existing scan limit is 50,000 emails.
Stopping still restarts the next scan from the beginning.

Manual checks before release:

1. Scan a real mailbox. Confirm count updates during a 500-email batch and
   the ETA appears only after the warm-up. Compare the displayed range with
   actual remaining time; record mailbox size and any throttling.
2. Close and reopen the popup during counting, scanning, and a retry. Confirm
   progress is restored and the scan remains active.
3. Use DevTools network throttling/offline mode on the service worker. Confirm
   retry/stale progress hides the old ETA, then recovers after a fresh warm-up.
4. Stop/restart and complete a scan. Confirm the loading description disappears
   outside analytics and the dashboard styles and layout are unchanged.
5. Check empty/small mailboxes and an authentication error. No ETA should be
   forced for scans that finish before there is enough timing data.

Mock checks do not establish real Gmail timing accuracy. Validate the range in
Chrome before publishing; an exact completion time is not guaranteed.

Reconnect reports success only after Chrome returns an OAuth token. An OAuth
window may not appear if Chrome can authorize from an existing session. If
reconnect fails, inspect the popup/service-worker Console for Chrome's error;
the success message alone must never appear after a failed token request.


## Version 1.0.3 publish draft

Changes:

- Live email scan progress and a dynamic estimate of time remaining.
- Earlier estimates when scanning speed is consistent, with a wider initial range.
- Reliable reconnect status: success requires an OAuth token.
- Consistent Gmail OAuth identity when loading the source folder for development.

The test ZIP includes the existing extension public key. The upload ZIP omits
that key. Both include only runtime files from the build allowlist; plans,
tests, release scripts, Git history, and local metadata are excluded.

User testing confirmed Gmail connectivity and the dynamic ETA. Automated scan,
estimator, storage, reconnect, and popup-flow tests passed. Secret checks cover
working files, all local Git history, and both staged packages. Re-run the build
checks for any later edits before uploading.
