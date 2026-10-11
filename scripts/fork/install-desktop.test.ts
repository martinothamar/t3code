// @effect-diagnostics nodeBuiltinImport:off - tests the script, which only uses Node built-ins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildEnvironment,
  parseDesktopEntryName,
  renderLauncher,
  replace,
} from "./install-desktop.ts";

describe("buildEnvironment", () => {
  it("passes on only the version of the build options, and nothing that adds a publish feed", () => {
    const env = buildEnvironment(
      {
        PATH: "/usr/bin",
        Cargo_Target_Dir: "/tmp/cargo",
        GITHUB_REPOSITORY: "martinothamar/t3code",
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
        GITHUB_TOKEN: "token",
        gh_token: "token",
        t3code_desktop_version: "0.0.45-fork.abc",
        T3CODE_DESKTOP_OUTPUT_DIR: "/tmp/out",
      },
      "0.0.46-nightly.20261010.2922",
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      T3CODE_DESKTOP_VERSION: "0.0.46-nightly.20261010.2922",
    });
  });
});

describe("parseDesktopEntryName", () => {
  it("reads the untranslated Name of the Desktop Entry group", () => {
    const entry = [
      "# comment",
      "[Desktop Action New]",
      "Name=New Window",
      "[Desktop Entry]",
      "Name[de]=T3 Code (Nächtlich)",
      "Name = T3 Code (Nightly)",
      "Exec=AppRun --no-sandbox %U",
    ].join("\n");

    expect(parseDesktopEntryName(entry)).toBe("T3 Code (Nightly)");
  });

  it("returns undefined without a Name", () => {
    expect(parseDesktopEntryName("[Desktop Entry]\nExec=AppRun\n")).toBeUndefined();
  });
});

describe("renderLauncher", () => {
  it("quotes an Exec path only when it has reserved characters", () => {
    const exec = (execPath: string) =>
      renderLauncher({ name: "T3 Code", execPath, iconPath: "/icon.png" })
        .split("\n")
        .find((line) => line.startsWith("Exec="));

    expect(exec("/home/martin/.local/bin/t3code")).toBe("Exec=/home/martin/.local/bin/t3code %U");
    expect(exec('/home/a b/100%$"x\\/t3code')).toBe(
      'Exec="/home/a b/100%%\\\\$\\\\"x\\\\\\\\/t3code" %U',
    );
  });
});

describe("replace", () => {
  let dir: string;
  afterEach(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const setup = () => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "install-desktop-test-"));
    const app = NodePath.join(dir, "T3 Code.app");
    NodeFS.mkdirSync(app);
    NodeFS.writeFileSync(NodePath.join(app, "version"), "old");
    return app;
  };

  it("swaps a directory in and leaves nothing beside it", () => {
    const app = setup();

    replace(app, (staged) => {
      NodeFS.mkdirSync(staged);
      NodeFS.writeFileSync(NodePath.join(staged, "version"), "new");
    });

    expect(NodeFS.readFileSync(NodePath.join(app, "version"), "utf8")).toBe("new");
    expect(NodeFS.readdirSync(dir)).toEqual(["T3 Code.app"]);
  });

  it("keeps the installed copy when writing the new one fails", () => {
    const app = setup();

    expect(() =>
      replace(app, (staged) => {
        NodeFS.mkdirSync(staged);
        throw new Error("copy failed");
      }),
    ).toThrow("copy failed");

    expect(NodeFS.readFileSync(NodePath.join(app, "version"), "utf8")).toBe("old");
    expect(NodeFS.readdirSync(dir)).toEqual(["T3 Code.app"]);
  });
});
