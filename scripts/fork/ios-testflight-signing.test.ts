import { describe, expect, it } from "vite-plus/test";

import {
  applyDistributionSigning,
  parseArguments,
  readProfile,
  setBuildNumber,
  type Profile,
} from "./ios-testflight-signing.ts";

const configuration = (name: string, settings: ReadonlyArray<string>) => `
		ABC${name} /* ${name} */ = {
			isa = XCBuildConfiguration;
			baseConfigurationReference = DEF /* Pods-T3Code.release.xcconfig */;
			buildSettings = {
${settings.map((line) => `				${line}\n`).join("")}			};
			name = ${name};
		};`;

const app = [
  "CODE_SIGN_ENTITLEMENTS = T3Code/T3Code.entitlements;",
  "CURRENT_PROJECT_VERSION = 1;",
  "DEVELOPMENT_TEAM = 47YFF3Z9FW;",
  "PRODUCT_BUNDLE_IDENTIFIER = net.example.t3code;",
];
const sharing = [
  "CODE_SIGN_STYLE = Automatic;",
  '"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";',
  'PRODUCT_BUNDLE_IDENTIFIER = "net.example.t3code.sharing";',
];
const project = [
  configuration("Debug", app),
  configuration("Release", app),
  configuration("Release", sharing),
  configuration("Release", ['"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";']),
].join("");

const profile = (bundleId: string): Profile => ({
  name: `T3 Code ${bundleId}`,
  uuid: `uuid-${bundleId}`,
  teamId: "47YFF3Z9FW",
  bundleId,
});

describe("applyDistributionSigning", () => {
  it("signs each Release target with its own profile and leaves the rest alone", () => {
    const signed = applyDistributionSigning(project, [
      profile("net.example.t3code"),
      profile("net.example.t3code.sharing"),
    ]);
    expect(signed).toBe(
      [
        configuration("Debug", app),
        configuration("Release", [
          "CODE_SIGN_STYLE = Manual;",
          'CODE_SIGN_IDENTITY = "Apple Distribution";',
          "DEVELOPMENT_TEAM = 47YFF3Z9FW;",
          'PROVISIONING_PROFILE_SPECIFIER = "T3 Code net.example.t3code";',
          "CODE_SIGN_ENTITLEMENTS = T3Code/T3Code.entitlements;",
          "CURRENT_PROJECT_VERSION = 1;",
          "PRODUCT_BUNDLE_IDENTIFIER = net.example.t3code;",
        ]),
        configuration("Release", [
          "CODE_SIGN_STYLE = Manual;",
          'CODE_SIGN_IDENTITY = "Apple Distribution";',
          "DEVELOPMENT_TEAM = 47YFF3Z9FW;",
          'PROVISIONING_PROFILE_SPECIFIER = "T3 Code net.example.t3code.sharing";',
          'PRODUCT_BUNDLE_IDENTIFIER = "net.example.t3code.sharing";',
        ]),
        configuration("Release", ['"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";']),
      ].join(""),
    );
  });

  it("refuses a target without a profile and a profile without a target", () => {
    expect(() => applyDistributionSigning(project, [profile("net.example.t3code")])).toThrow(
      "No provisioning profile for net.example.t3code.sharing.",
    );
    expect(() =>
      applyDistributionSigning(project, [
        profile("net.example.t3code"),
        profile("net.example.t3code.sharing"),
        profile("net.example.t3code.widgets"),
      ]),
    ).toThrow("No target uses the profile for net.example.t3code.widgets.");
  });
});

it("sets the build number in the project and in literal Info.plist values only", () => {
  expect(setBuildNumber("CURRENT_PROJECT_VERSION = 1;\nCURRENT_PROJECT_VERSION = 1;", 61)).toBe(
    "CURRENT_PROJECT_VERSION = 61;\nCURRENT_PROJECT_VERSION = 61;",
  );
  expect(setBuildNumber("<key>CFBundleVersion</key>\n\t<string>1</string>", 61)).toBe(
    "<key>CFBundleVersion</key>\n\t<string>61</string>",
  );
  const inherited = "<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>";
  expect(setBuildNumber(inherited, 61)).toBe(inherited);
});

it("reads the bundle identifier and team from a profile", () => {
  expect(
    readProfile({
      Name: "T3 Code",
      UUID: "1234",
      TeamIdentifier: ["47YFF3Z9FW"],
      Entitlements: { "application-identifier": "47YFF3Z9FW.net.example.t3code.widgets" },
    }),
  ).toEqual({
    name: "T3 Code",
    uuid: "1234",
    teamId: "47YFF3Z9FW",
    bundleId: "net.example.t3code.widgets",
  });
  expect(() => readProfile({ Name: "x" })).toThrow("Not an iOS provisioning profile.");
});

it("requires every option and a positive build number", () => {
  const base = ["--project", "ios", "--profiles", "p", "--export-options", "e.plist"];
  expect(parseArguments([...base, "--build-number", "61"]).buildNumber).toBe(61);
  expect(() => parseArguments([...base, "--build-number", "0"])).toThrow("positive integer");
  expect(() => parseArguments(base)).toThrow("--build-number is required.");
});
