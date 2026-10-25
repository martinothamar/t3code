# The fork's iOS app

The fork builds its own iOS app, signed with your own Apple team, so the phone gets the fork's
features. The fork's builds have T3 Connect turned off, so the phone gets no push notifications.

## Building and installing

You need a paid Apple Developer Program membership: push, App Groups and the widget and share
extensions cannot be signed by a Personal Team, and Personal Team builds expire after seven days.
A free account still works with `T3CODE_IOS_PERSONAL_TEAM=1` (see `apps/mobile/README.md`), without
the extensions; add `T3CODE_IOS_TEAM_ID` with the Personal Team's ID, the `OU` of its Apple
Development certificate, to sign with it rather than leave the choice to Expo.

1. In Xcode → Settings → Accounts, sign in with the Apple ID of your team.
2. Connect the iPhone, trust the Mac, and turn on Settings → Privacy & Security → Developer Mode.
3. From `apps/mobile`, with your team ID (Membership details in the developer portal), a bundle
   identifier you own and the device's udid from `xcrun devicectl list devices`:

   ```sh
   T3CODE_IOS_TEAM_ID=ABCDE12345 \
   T3CODE_IOS_BUNDLE_ID=com.example.t3code \
   vp run ios:release --device <device udid>
   ```

   Run it again to install a newer commit. Over-the-air updates are off for these builds, since
   upstream's update channel would replace the fork's JavaScript.

The first device build for a new bundle identifier can stop at "No profiles for '<bundle id>' were
found": Expo lets Xcode create provisioning profiles only when the project names no team, and these
builds name yours. Build once with provisioning allowed; it registers the app ID, its capabilities,
the App Group and the extension IDs, and later `vp run ios:release` runs reuse the profile:

```sh
cd apps/mobile
xcodebuild -workspace ios/T3Code.xcworkspace -scheme T3Code -configuration Release \
  -destination id=<device udid> DEVELOPMENT_TEAM=<team id> \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration
xcrun devicectl device install app --device <device udid> \
  ~/Library/Developer/Xcode/DerivedData/T3Code-*/Build/Products/Release-iphoneos/T3Code.app
```

Signing asks for the Mac login password to use the
certificate's key; answer Always Allow, since a denied prompt leaves a framework unsigned and the
phone refuses the app. If `security find-identity -v -p codesigning` lists no valid identity after
Xcode created the certificate, the keychain lacks Apple's current intermediate: add
[AppleWWDRCAG3.cer](https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer) to the login
keychain. On the phone, trust the developer once under Settings → General → VPN & Device
Management.

## TestFlight

Fork release uploads each published release's app to TestFlight, numbered by the release's run, so
a phone in the internal testing group installs it without a cable. A TestFlight build expires after
90 days. The job runs on the self-hosted Mac (`scripts/fork/setup-mac-runner.sh`, whose VM has
Xcode) and signs manually: Xcode's own signing in CI would need an App Store Connect key allowed to
manage certificates. It is skipped until the repository has the following, set up once:

1. In App Store Connect, the app record for your bundle identifier, and an internal testing group
   with automatic distribution that you are in.
2. An Apple Distribution certificate: Xcode → Settings → Accounts → your team → Manage Certificates
   → + → Apple Distribution. Export it from Keychain Access (My Certificates) as a `.p12` with a
   password.
3. In the developer portal, under Profiles, an App Store Connect profile with that certificate for
   each of the app's identifiers: the bundle identifier and its `.widgets` and `.sharing`
   extensions. Download the three.
4. The repository's variables and secrets, from the folder holding the files:

   ```sh
   gh variable set IOS_TEAM_ID --body ABCDE12345
   gh variable set IOS_BUNDLE_ID --body com.example.t3code
   base64 -i distribution.p12 | gh secret set IOS_DISTRIBUTION_CERTIFICATE
   gh secret set IOS_DISTRIBUTION_CERTIFICATE_PASSWORD
   tar -cz *.mobileprovision | base64 | gh secret set IOS_PROVISIONING_PROFILES
   ```

   The upload uses the App Store Connect key the macOS builds notarize with (`APPLE_API_KEY`,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`); its Developer role may upload builds.

The certificate and profiles last a year. Renew them the same way and replace the secrets.
