import { describe, expect, it } from "vite-plus/test";

import { buildEnvironment, parseDesktopEntryName, renderLauncher } from "./install-desktop.ts";

describe("buildEnvironment", () => {
  it("sets the version and drops what moves cargo output or selects a publish feed", () => {
    const env = buildEnvironment(
      {
        PATH: "/usr/bin",
        Cargo_Target_Dir: "/tmp/cargo",
        GITHUB_REPOSITORY: "martinothamar/t3code",
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
        GITHUB_TOKEN: "token",
        gh_token: "token",
        t3code_desktop_version: "0.0.45-fork.abc",
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
  it("writes the launcher for the installed AppImage", () => {
    expect(
      renderLauncher({
        name: "T3 Code (Nightly)",
        execPath: "/home/martin/.local/bin/t3code",
        iconPath: "/home/martin/.local/share/icons/t3code.png",
      }),
    ).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=T3 Code (Nightly)",
        "Exec=/home/martin/.local/bin/t3code %U",
        "Icon=/home/martin/.local/share/icons/t3code.png",
        "Terminal=false",
        "Categories=Development;",
        "StartupWMClass=t3code",
        "",
      ].join("\n"),
    );
  });

  it("quotes an Exec path with reserved characters", () => {
    const launcher = renderLauncher({
      name: "T3 Code",
      execPath: '/home/a b/100%$"x\\/t3code',
      iconPath: "/icon.png",
    });

    expect(launcher).toContain('Exec="/home/a b/100%%\\\\$\\\\"x\\\\\\\\/t3code" %U\n');
  });
});
