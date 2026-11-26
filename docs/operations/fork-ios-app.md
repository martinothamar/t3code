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
