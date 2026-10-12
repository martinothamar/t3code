//! T3 Code × agentctl Sandboxes: how to set it up and what using it looks like.
//!
//! Scenes, in order:
//!   Title → Diagram (how the pieces fit) → Setup (typed terminal) → Manifest (agent.yaml) →
//!   footage shots (create a Sandbox, a thread on the agent's own desktop, stop/start/delete) →
//!   Recap.
//! Footage shots are pre-cut, already sped-up segments in `../footage/seg` (see the skill's
//! `scripts/cut.sh`); each plays at 1x inside a window card with camera keyframes, captions, a
//! chapter label and a speed badge. Consecutive scenes cross-fade over XFADE seconds.
//!
//! Layout is drawn on a 1920x1080 grid; `--scale`/`--draft` scale it automatically.
use fframes::{
    AnimateRuntimeInput, AudioMap, Color, Duration, FFramesContext, FontQuery, Frame, Overlap,
    Scene, Scenes, Svgr, SyncVideoFrameInput, Video,
    animation::{AnimationRuntime, Easing},
    include_media_dir,
    FFramesSyncedVideoFrame as _,
    usvgr::PreloadedImageData,
};
use std::sync::{Arc, LazyLock};

include_media_dir!(pub struct DemoMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
pub const FPS: usize = 30;

/// Cross-fade length between scenes, seconds.
const XFADE: f32 = 0.5;

// Palette
const BG_TOP: &str = "#0b1020";
const BG_BOTTOM: &str = "#1b1240";
const TEXT: &str = "#f5f7ff";
const MUTED: &str = "#a6adc8";
const DIM: &str = "#6c7393";
const ACCENT: &str = "#7c9cff";
const ACCENT_2: &str = "#c084fc";
const GREEN: &str = "#4ade80";
const YELLOW: &str = "#facc15";
const SANS: &str = "Inter";
const MONO: &str = "JetBrains Mono";

static FADE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(XFADE, &Easing::EaseInOut));
static EASE_OUT: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.6, &Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)));
static CAPTION_FADE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.35, &Easing::EaseInOut));

// ---------------------------------------------------------------------------------------
// the video

pub struct DemoVideo<'a> {
    pub media: &'a DemoMedia,
    title: TitleScene,
    diagram: DiagramScene,
    setup: SetupScene,
    manifest: ManifestScene,
    shots: Vec<Shot>,
    recap: RecapScene,
}

impl<'a> DemoVideo<'a> {
    pub fn new(media: &'a DemoMedia) -> Self {
        Self {
            media,
            title: TitleScene,
            diagram: DiagramScene,
            setup: SetupScene,
            manifest: ManifestScene,
            shots: shots(),
            recap: RecapScene,
        }
    }
}

impl std::fmt::Debug for DemoVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DemoVideo").finish()
    }
}

impl Video for DemoVideo<'_> {
    const FPS: usize = FPS;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn define_scenes(&self) -> Scenes<'_> {
        let mut scenes: Vec<&dyn Scene> = vec![&self.title, &self.diagram, &self.setup, &self.manifest];
        scenes.extend(self.shots.iter().map(|s| s as &dyn Scene));
        scenes.push(&self.recap);
        Scenes::from(scenes)
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let glow_x = 1500.0 - (frame.seconds() * 7.0) % 1200.0;
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={WIDTH} height={HEIGHT} viewBox="0 0 1920 1080">
                <defs>
                    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
                        <stop offset="0" stop-color={BG_TOP} />
                        <stop offset="1" stop-color={BG_BOTTOM} />
                    </linearGradient>
                    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#5b5bd6" stop-opacity="0.40" />
                        <stop offset="1" stop-color="#5b5bd6" stop-opacity="0" />
                    </radialGradient>
                    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
                        <feDropShadow dx="0" dy="30" stdDeviation="30" flood-color="#000" flood-opacity="0.55" />
                    </filter>
                </defs>
                <rect width="1920" height="1080" fill="url(#bg)" />
                <circle cx={glow_x} cy="240" r="760" fill="url(#glow)" />
                {ctx.render_scenes(&frame)}
            </svg>
        )
    }
}

// ---------------------------------------------------------------------------------------
// helpers

/// Opacity of a scene `total` seconds long (its duration plus its own overlap): fades in over
/// the first XFADE seconds and out over the last XFADE seconds.
fn scene_opacity(frame: &Frame, total: f32, fade_in: bool, fade_out: bool) -> f32 {
    let mut o = 1.0_f32;
    if fade_in {
        o = o.min(frame.animate_runtime(AnimateRuntimeInput { on_second: 0.0, from: 0.0, to: 1.0, animation_runtime: &FADE }));
    }
    if fade_out {
        o = o.min(frame.animate_runtime(AnimateRuntimeInput { on_second: total - XFADE, from: 1.0, to: 0.0, animation_runtime: &FADE }));
    }
    o
}

fn ease_out(frame: &Frame, start: f32) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: start, from: 0.0, to: 1.0, animation_runtime: &EASE_OUT })
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn ease_in_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 }
}

/// Opacity of something shown from `start` to `end` seconds, fading at both ends.
fn window_opacity(frame: &Frame, start: f32, end: f32) -> f32 {
    let fade_in: f32 = frame.animate_runtime(AnimateRuntimeInput { on_second: start, from: 0.0, to: 1.0, animation_runtime: &CAPTION_FADE });
    let fade_out: f32 = frame.animate_runtime(AnimateRuntimeInput { on_second: end - 0.35, from: 1.0, to: 0.0, animation_runtime: &CAPTION_FADE });
    fade_in.min(fade_out)
}

/// Frame `index` of a footage file, clamped to its last frame (`frames` long).
fn footage_frame(frame: &Frame, ctx: &FFramesContext<'_, '_>, file: &str, index: usize, frames: usize) -> Option<Arc<PreloadedImageData>> {
    let mut shifted = frame.clone();
    shifted.index = index.min(frames.saturating_sub(1));
    let input = SyncVideoFrameInput { start_from: 0.0, looping: false, editor_fallback_image: None };
    let video_frame = shifted.get_synced_video_frame(ctx, file, &input)?;
    Some(video_frame.into_image().href())
}

/// A caption pill centred at (960, y), sized to its text.
fn caption<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, text: &'a str, y: f32, opacity: f32) -> Svgr<'a> {
    if opacity <= 0.0 {
        return Svgr::empty();
    }
    let font = FontQuery { family: SANS, size: 32, weight: 500, ..Default::default() };
    let w = frame.text_width(ctx, font, text).unwrap_or(text.len() * 16) as f32 + 72.0;
    fframes::svgr!(
        <g opacity={opacity}>
            <rect x={960.0 - w / 2.0} y={y - 34.0} width={w} height="68" rx="34" fill="#05060c" fill-opacity="0.78" stroke="#ffffff" stroke-opacity="0.08" />
            <text x="960" y={y + 11.0} text-anchor="middle" font-family={SANS} font-weight="500" font-size="32" fill={TEXT}>{text}</text>
        </g>
    )
}

/// Window chrome (shadow, body, title bar) with a title in the middle and an optional label
/// on the left.
fn window_chrome<'a>(x: f32, y: f32, w: f32, h: f32, title: &'a str, label: &'a str) -> Svgr<'a> {
    fframes::svgr!(
        <g>
            <rect x={x} y={y} width={w} height={h} rx="16" fill="#11131c" filter="url(#shadow)" />
            <rect x={x} y={y} width={w} height="44" rx="16" fill="#232634" />
            <rect x={x} y={y + 28.0} width={w} height="16" fill="#232634" />
            <circle cx={x + 26.0} cy={y + 22.0} r="7" fill="#ff5f57" />
            <circle cx={x + 50.0} cy={y + 22.0} r="7" fill="#febc2e" />
            <circle cx={x + 74.0} cy={y + 22.0} r="7" fill="#28c840" />
            <text x={x + 104.0} y={y + 29.0} font-family={SANS} font-weight="600" font-size="19" fill={ACCENT}>{label}</text>
            <text x={x + w / 2.0} y={y + 29.0} text-anchor="middle" font-family={SANS} font-weight="500" font-size="19" fill={MUTED}>{title}</text>
        </g>
    )
}

// ---------------------------------------------------------------------------------------
// Title

#[derive(Debug)]
struct TitleScene;
const TITLE_SECONDS: f32 = 5.0;

impl Scene for TitleScene {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(TITLE_SECONDS)
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let opacity = scene_opacity(&frame, TITLE_SECONDS, false, true);
        let p1 = ease_out(&frame, 0.2);
        let p2 = ease_out(&frame, 0.55);
        let p3 = ease_out(&frame, 1.0);
        fframes::svgr!(
            <g opacity={opacity}>
                <g opacity={p1} transform={format!("translate(0 {})", (1.0 - p1) * 50.0)}>
                    <text x="960" y="470" text-anchor="middle" font-family={SANS} font-weight="700" font-size="128" letter-spacing="-3" fill={TEXT}>
                        "T3 Code × agentctl"
                    </text>
                </g>
                <g opacity={p2} transform={format!("translate(0 {})", (1.0 - p2) * 40.0)}>
                    <text x="960" y="560" text-anchor="middle" font-family={SANS} font-weight="500" font-size="46" fill={MUTED}>
                        "Coding agents in their own Sandboxes, driven from one app"
                    </text>
                </g>
                <g opacity={p3}>
                    <rect x="760" y="640" width="400" height="56" rx="28" fill="#1e2440" stroke={ACCENT} stroke-opacity="0.6" />
                    <text x="960" y="677" text-anchor="middle" font-family={SANS} font-weight="600" font-size="24" fill={ACCENT}>"Setup and a walkthrough"</text>
                </g>
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// Diagram: how the pieces fit

#[derive(Debug)]
struct DiagramScene;
const DIAGRAM_SECONDS: f32 = 13.0;

impl Scene for DiagramScene {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(DIAGRAM_SECONDS)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = DIAGRAM_SECONDS + XFADE;
        let opacity = scene_opacity(&frame, total, true, true);

        let laptop = ease_out(&frame, 0.5);
        let sandbox = ease_out(&frame, 1.6);
        let link: f32 = frame.animate_runtime(AnimateRuntimeInput { on_second: 2.6, from: 0.0, to: 1.0, animation_runtime: &EASE_OUT });

        // Things that run inside the Sandbox, appearing one by one.
        let chips: Vec<Svgr> = [
            ("Claude Code · Codex", "the agents, with credentials agentctl mediates", 3.6_f32),
            ("T3 server", "installed over SSH by the app", 4.4),
            ("A desktop", "terminal and Chromium, viewable over noVNC", 5.2),
            ("localtest", "containers started by studioctl", 6.0),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (name, what, at))| {
            let p = ease_out(&frame, at);
            let y = 372.0 + i as f32 * 112.0;
            fframes::svgr!(
                <g opacity={p} transform={format!("translate({} 0)", (1.0 - p) * 30.0)}>
                    <rect x="1000" y={y} width="680" height="92" rx="16" fill="#151a30" stroke="#ffffff" stroke-opacity="0.08" />
                    <circle cx="1036" cy={y + 46.0} r="7" fill={GREEN} />
                    <text x="1062" y={y + 42.0} font-family={SANS} font-weight="600" font-size="28" fill={TEXT}>{name}</text>
                    <text x="1062" y={y + 74.0} font-family={SANS} font-weight="400" font-size="21" fill={MUTED}>{what}</text>
                </g>
            )
        })
        .collect();

        let captions: [(f32, f32, &'static str); 3] = [
            (0.6, 3.4, "The desktop app runs on your computer"),
            (3.4, 8.6, "Each agentctl Sandbox is its own machine, reached over SSH"),
            (8.6, total - 0.2, "Its threads, terminals and browser all run in the Sandbox"),
        ];
        let caption_svgs: Vec<Svgr> = captions
            .iter()
            .map(|&(s, e, text)| {
                let o = window_opacity(&frame, s, e);
                caption(&mut frame, ctx, text, 990.0, o)
            })
            .collect();

        fframes::svgr!(
            <g opacity={opacity}>
                <text x="960" y="150" text-anchor="middle" font-family={SANS} font-weight="700" font-size="60" fill={TEXT}
                      opacity={ease_out(&frame, 0.1)}>"How it fits together"</text>
                // the laptop
                <g opacity={laptop} transform={format!("translate(0 {})", (1.0 - laptop) * 30.0)}>
                    <rect x="200" y="400" width="520" height="330" rx="24" fill="#1e2440" stroke={ACCENT} stroke-width="2" />
                    <text x="460" y="380" text-anchor="middle" font-family={SANS} font-weight="600" font-size="26" fill={MUTED}>"Your computer"</text>
                    <rect x="250" y="450" width="420" height="230" rx="14" fill="#0d0f17" />
                    <circle cx="276" cy="474" r="6" fill="#ff5f57" />
                    <circle cx="296" cy="474" r="6" fill="#febc2e" />
                    <circle cx="316" cy="474" r="6" fill="#28c840" />
                    <text x="460" y="575" text-anchor="middle" font-family={SANS} font-weight="700" font-size="44" fill={TEXT}>"T3 Code"</text>
                    <text x="460" y="620" text-anchor="middle" font-family={SANS} font-weight="500" font-size="22" fill={MUTED}>"desktop app (the fork)"</text>
                </g>
                // the Sandbox
                <g opacity={sandbox} transform={format!("translate(0 {})", (1.0 - sandbox) * 30.0)}>
                    <rect x="960" y="260" width="760" height="580" rx="28" fill="#10142a" stroke={ACCENT_2} stroke-width="2" stroke-dasharray="10 8" />
                    <text x="1000" y="318" font-family={MONO} font-weight="700" font-size="28" fill={ACCENT_2}>"altinn-desktop-1"</text>
                    <text x="1680" y="318" text-anchor="end" font-family={SANS} font-weight="500" font-size="22" fill={MUTED}>"agentctl Sandbox (microVM)"</text>
                </g>
                {chips}
                // the SSH link
                <g opacity={link.min(1.0)}>
                    <path d={format!("M730 565 H{}", 730.0 + 210.0 * link)} stroke={GREEN} stroke-width="5" stroke-linecap="round" />
                    <path d="M928 553 L944 565 L928 577" fill="none" stroke={GREEN} stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity={link} />
                    <text x="835" y="545" text-anchor="middle" font-family={MONO} font-weight="700" font-size="28" fill={GREEN}>"SSH"</text>
                    <text x="835" y="602" text-anchor="middle" font-family={MONO} font-weight="400" font-size="15" fill={MUTED}>"agentctl-altinn-desktop-1"</text>
                </g>
                {caption_svgs}
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// Setup: a typed terminal session

#[derive(Debug)]
struct SetupScene;

#[derive(Clone, Copy)]
enum Line {
    Comment(&'static str),
    Command(&'static str),
    Output(&'static str),
}

const SETUP: &[Line] = &[
    Line::Comment("# agentctl, from github.com/digdir/digdir-agents"),
    Line::Command("agentctl claude login"),
    Line::Output("claude authentication stored"),
    Line::Comment("# 1. The T3 Code fork's desktop app"),
    Line::Command("git clone https://github.com/martinothamar/t3code && cd t3code"),
    Line::Command("node scripts/fork/install-desktop.ts"),
    Line::Comment("# 2. Let SSH reach Sandboxes as agentctl-NAME"),
    Line::Command("agentctl ssh-config install"),
    Line::Comment("# 3. Manifests to create Sandboxes from, tokens in .env"),
    Line::Command("git clone https://github.com/Altinn/altinn-studio"),
    Line::Command("cd altinn-studio/agents/desktop && cp .env.sample .env"),
];
/// Typed characters per second, and pauses.
const CPS: f32 = 45.0;
const AFTER_COMMAND: f32 = 0.55;
const AFTER_COMMENT: f32 = 0.45;
const SETUP_START: f32 = 0.8;

/// (start, end) of each line's appearance; commands type out between the two.
fn setup_schedule() -> Vec<(f32, f32)> {
    let mut t = SETUP_START;
    SETUP
        .iter()
        .map(|line| {
            let start = t;
            let (end, next) = match line {
                Line::Command(s) => {
                    let end = start + s.chars().count() as f32 / CPS;
                    (end, end + AFTER_COMMAND)
                }
                Line::Comment(_) => (start, start + AFTER_COMMENT),
                Line::Output(_) => (start, start + 0.4),
            };
            t = next;
            (start, end)
        })
        .collect()
}

fn setup_seconds() -> f32 {
    setup_schedule().last().map(|&(_, e)| e).unwrap_or(0.0) + 2.6
}

impl Scene for SetupScene {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(setup_seconds())
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = setup_seconds() + XFADE;
        let opacity = scene_opacity(&frame, total, true, true);
        let t = frame.seconds();
        const FS: f32 = 27.0;
        const LH: f32 = 46.0;
        let x0 = 240.0;
        let y0 = 270.0;
        let schedule = setup_schedule();

        let mut cursor = (x0, y0);
        let mut typing = false;
        let lines: Vec<Svgr> = SETUP
            .iter()
            .zip(schedule.iter())
            .enumerate()
            .filter(|(_, (_, (start, _)))| t >= *start)
            .map(|(i, (line, &(start, end)))| {
                let y = y0 + i as f32 * LH;
                match *line {
                    Line::Comment(s) => {
                        cursor = (x0, y + LH);
                        fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={DIM}>{s}</text>)
                    }
                    Line::Output(s) => {
                        cursor = (x0 + 2.0 * 0.6 * FS, y + LH);
                        fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={GREEN}>{s}</text>)
                    }
                    Line::Command(s) => {
                        let n = s.chars().count();
                        let typed = if t >= end { n } else { (((t - start) * CPS) as usize).min(n) };
                        let text: String = s.chars().take(typed).collect();
                        let text_x = x0 + 2.0 * 0.6 * FS;
                        typing = t < end;
                        cursor = if t < end { (text_x + typed as f32 * 0.6 * FS, y) } else { (text_x, y + LH) };
                        fframes::svgr!(
                            <g>
                                <text x={x0} y={y} font-family={MONO} font-weight="700" font-size={FS} fill={ACCENT}>"$"</text>
                                <text x={text_x} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={TEXT}>{text}</text>
                            </g>
                        )
                    }
                }
            })
            .collect();
        // Next prompt after the last line, with a blinking cursor.
        let last_end = schedule.last().map(|&(_, e)| e).unwrap_or(0.0);
        let final_prompt = if t >= last_end + AFTER_COMMAND {
            let y = y0 + SETUP.len() as f32 * LH;
            cursor = (x0 + 2.0 * 0.6 * FS, y);
            fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="700" font-size={FS} fill={ACCENT}>"$"</text>)
        } else {
            Svgr::empty()
        };
        let blink_on = typing || ((t * 2.0) as usize) % 2 == 0;

        let cap_text = "Once, on your computer: four things to install and clone";
        let cap_o = window_opacity(&frame, 0.5, total - 0.2);
        let cap = caption(&mut frame, ctx, cap_text, 990.0, cap_o);

        fframes::svgr!(
            <g opacity={opacity}>
                <text x="960" y="120" text-anchor="middle" font-family={SANS} font-weight="700" font-size="56" fill={TEXT}
                      opacity={ease_out(&frame, 0.1)}>"Set it up"</text>
                <g opacity={ease_out(&frame, 0.2)}>
                    {window_chrome(190.0, 170.0, 1540.0, 740.0, "Terminal", "")}
                    {lines}
                    {final_prompt}
                    <rect x={cursor.0} y={cursor.1 - FS * 0.8} width={FS * 0.55} height={FS} fill={TEXT} opacity={if blink_on { 0.85 } else { 0.0 }} />
                </g>
                {cap}
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// Manifest: what makes an Agent reachable

#[derive(Debug)]
struct ManifestScene;
const MANIFEST_SECONDS: f32 = 9.0;

const MANIFEST: &[(&str, bool)] = &[
    ("apiVersion: agents.platform/v1alpha1", false),
    ("kind: Agent", false),
    ("metadata:", false),
    ("  name: altinn-desktop", false),
    ("spec:", false),
    ("  sandbox:", false),
    ("    image:", false),
    ("      reference: ghcr.io/altinn/altinn-studio/agent-desktop:latest", false),
    ("  …", false),
    ("  access:", true),
    ("    - type: ssh    # T3 Code connects over SSH", true),
    ("    - type: vnc    # and you can watch its desktop", true),
];

impl Scene for ManifestScene {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(MANIFEST_SECONDS)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = MANIFEST_SECONDS + XFADE;
        let opacity = scene_opacity(&frame, total, true, true);
        let hl = ease_out(&frame, 2.4);
        const FS: f32 = 28.0;
        const LH: f32 = 46.0;
        let (x0, y0) = (340.0, 300.0);
        let first_hl = MANIFEST.iter().position(|(_, h)| *h).unwrap_or(0);
        let lines: Vec<Svgr> = MANIFEST
            .iter()
            .enumerate()
            .map(|(i, &(s, highlighted))| {
                let y = y0 + i as f32 * LH;
                let fill = if highlighted { TEXT } else { MUTED };
                let o = if highlighted { 1.0 } else { lerp(1.0, 0.55, hl) };
                fframes::svgr!(<text x={x0} y={y} font-family={MONO} font-weight="400" font-size={FS} fill={fill} opacity={o}>{s}</text>)
            })
            .collect();
        let hl_y = y0 + first_hl as f32 * LH - 34.0;
        let hl_h = (MANIFEST.len() - first_hl) as f32 * LH + 4.0;
        let cap_o = window_opacity(&frame, 0.6, total - 0.2);
        let cap = caption(&mut frame, ctx, "Sandboxes show up in T3 Code when their manifest gives SSH access", 990.0, cap_o);
        fframes::svgr!(
            <g opacity={opacity}>
                <text x="960" y="120" text-anchor="middle" font-family={SANS} font-weight="700" font-size="56" fill={TEXT}
                      opacity={ease_out(&frame, 0.1)}>"Altinn Studio's desktop Agent"</text>
                <g opacity={ease_out(&frame, 0.2)}>
                    {window_chrome(290.0, 190.0, 1340.0, 700.0, "altinn-studio/agents/desktop/agent.yaml", "")}
                    <rect x={x0 - 24.0} y={hl_y} width={(1220.0 * hl).max(1.0)} height={hl_h} rx="10" fill={YELLOW} fill-opacity="0.12" stroke={YELLOW} stroke-opacity={0.6 * hl} />
                    {lines}
                </g>
                {cap}
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// Footage shots

/// A camera keyframe: at scene second `t`, show `zoom`x around (`x`, `y`) in source pixels
/// (the recordings are 1600x900).
#[derive(Debug, Clone, Copy)]
struct Cam(f32, f32, f32, f32);

#[derive(Debug)]
struct Shot {
    name: &'static str,
    file: &'static str,
    /// Length of the segment file, seconds.
    len: f32,
    chapter: &'static str,
    /// Speed-up already applied to the segment, shown as a badge when above 1.
    speed: f32,
    cams: &'static [Cam],
    captions: &'static [(f32, f32, &'static str)],
    /// Highlight rings: (start, end, x, y, w, h) in source pixels.
    rings: &'static [(f32, f32, f32, f32, f32, f32)],
    fade_out: bool,
}

const CREATE: &str = "1 · Create a Sandbox";
const WORK: &str = "2 · Work in it";
const MANAGE: &str = "3 · Stop, start, delete";

// Screenshot coordinates in this file's comments were 1456x819; source pixels are 1600x900
// (x 1.0989).
fn shots() -> Vec<Shot> {
    vec![
        // --- create -------------------------------------------------------------------
        Shot {
            name: "CreateDialog", file: "c1.mp4", len: 14.0, chapter: CREATE, speed: 1.5,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.0, 800.0, 450.0), Cam(2.6, 1.55, 800.0, 430.0),
                    Cam(6.4, 1.55, 800.0, 430.0), Cam(7.4, 1.3, 800.0, 600.0), Cam(12.0, 1.3, 800.0, 600.0),
                    Cam(12.8, 1.55, 840.0, 470.0)],
            captions: &[(0.4, 6.6, "New Sandbox, from a folder of agentctl manifests"),
                        (6.6, 12.4, "T3 Code lists every Agent and variant in it"),
                        (12.4, 14.0, "Create")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "CreateProvision", file: "c2.mp4", len: 10.366, chapter: CREATE, speed: 8.0,
            cams: &[Cam(0.0, 1.45, 620.0, 260.0)],
            captions: &[(0.3, 10.4, "agentctl provisions it, and T3 Code follows along")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "CreateReady", file: "c3.mp4", len: 8.0, chapter: CREATE, speed: 1.0,
            cams: &[Cam(0.0, 1.45, 620.0, 260.0), Cam(8.0, 1.6, 700.0, 220.0)],
            captions: &[(0.3, 8.0, "Ready: it installs its server over SSH and connects")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "CreateThread", file: "c4.mp4", len: 9.0, chapter: CREATE, speed: 1.0,
            cams: &[Cam(0.0, 1.6, 700.0, 220.0), Cam(3.6, 1.6, 900.0, 220.0), Cam(4.8, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 9.0, "The Sandbox is a project now. Start a thread in it")],
            rings: &[],
            fade_out: true,
        },
        // --- work -----------------------------------------------------------------------
        Shot {
            name: "ThreadPrompt", file: "t1.mp4", len: 9.0, chapter: WORK, speed: 1.0,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.0, 1.7, 905.0, 390.0)],
            captions: &[(0.4, 9.0, "Ask the agent to work on its own desktop, where you can watch")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadPopup", file: "t2.mp4", len: 10.5, chapter: WORK, speed: 2.0,
            cams: &[Cam(0.0, 1.45, 800.0, 260.0), Cam(7.6, 1.45, 800.0, 260.0), Cam(8.8, 2.3, 1420.0, 745.0)],
            captions: &[(0.3, 7.6, "It opens its desktop with T3 Code's browser tool"),
                        (7.6, 10.5, "A floating preview pops up: Agent has control")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadPopupWork", file: "t3.mp4", len: 8.0, chapter: WORK, speed: 8.0,
            cams: &[Cam(0.0, 2.3, 1420.0, 745.0)],
            captions: &[(0.0, 8.0, "Inside: the agent's own terminal, in the Sandbox")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadPanel", file: "t4.mp4", len: 12.8, chapter: WORK, speed: 1.25,
            cams: &[Cam(0.0, 1.6, 1250.0, 300.0), Cam(2.2, 1.6, 1250.0, 300.0), Cam(3.4, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 7.6, "Open it in the right panel, beside the chat"),
                        (7.6, 12.8, "…and give it some room")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadEnvUp", file: "t5.mp4", len: 13.6, chapter: WORK, speed: 2.5,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.2, 1.75, 1112.0, 390.0)],
            captions: &[(0.3, 13.6, "studioctl env up starts localtest: four containers in the Sandbox")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadLocaltest", file: "t6.mp4", len: 14.0, chapter: WORK, speed: 1.0,
            cams: &[Cam(0.0, 1.75, 1112.0, 390.0), Cam(3.2, 1.75, 1112.0, 390.0), Cam(4.6, 1.3, 1080.0, 420.0)],
            captions: &[(0.3, 7.0, "Then it opens localtest in Chromium, on its desktop"),
                        (7.0, 14.0, "App Localtest, served and shown from inside the Sandbox")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadSummary", file: "t7.mp4", len: 7.666, chapter: WORK, speed: 3.0,
            cams: &[Cam(0.0, 1.3, 1080.0, 420.0), Cam(1.4, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 7.7, "Your computer only ran the T3 Code app")],
            rings: &[],
            fade_out: true,
        },
        // --- manage ---------------------------------------------------------------------
        Shot {
            name: "ManageStop", file: "l1.mp4", len: 14.0, chapter: MANAGE, speed: 1.5,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.45, 930.0, 300.0)],
            captions: &[(0.4, 6.0, "Sandboxes: state, resources and threads"),
                        (6.0, 14.0, "Stop keeps its disk")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ManageStart", file: "l2.mp4", len: 10.0, chapter: MANAGE, speed: 2.0,
            cams: &[Cam(0.0, 1.45, 930.0, 300.0)],
            captions: &[(0.3, 10.0, "Start it again, and T3 Code reconnects")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ManageThread", file: "l3.mp4", len: 7.0, chapter: MANAGE, speed: 1.0,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.55, 470.0, 330.0)],
            captions: &[(0.3, 7.0, "Its threads are still there")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ManageDelete", file: "l4.mp4", len: 12.8, chapter: MANAGE, speed: 1.25,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.45, 930.0, 330.0), Cam(9.0, 1.45, 930.0, 330.0), Cam(10.2, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 12.8, "Delete removes the Sandbox, its disk, project and threads")],
            rings: &[],
            fade_out: true,
        },
    ]
}

/// Camera at scene second `t`: eased between keyframes, held outside them.
fn camera_at(cams: &[Cam], t: f32) -> (f32, f32, f32) {
    let first = cams[0];
    if t <= first.0 {
        return (first.1, first.2, first.3);
    }
    for w in cams.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t <= b.0 {
            let p = ease_in_out((t - a.0) / (b.0 - a.0).max(0.001));
            return (lerp(a.1, b.1, p), lerp(a.2, b.2, p), lerp(a.3, b.3, p));
        }
    }
    let last = cams[cams.len() - 1];
    (last.1, last.2, last.3)
}

// The recording's place on the 1920x1080 grid, 0.96x of 1600x900. Only the top 870 source
// pixels show: the bottom 30 are the recording desktop's own taskbar.
const SRC_W: f32 = 1600.0;
const SRC_VISIBLE_H: f32 = 870.0;
const CX: f32 = 192.0;
const CY: f32 = 112.0;
const CW: f32 = 1536.0;
const K: f32 = CW / SRC_W;
const CH: f32 = SRC_VISIBLE_H * K;
const IMG_H: f32 = 900.0 * K;

impl Scene for Shot {
    fn name(&self) -> &'static str {
        self.name
    }

    // Overlap makes the scene XFADE longer, so its own length leaves that out: the footage
    // plays exactly once.
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.len - XFADE)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = self.len;
        let t = frame.seconds();
        let opacity = scene_opacity(&frame, total, true, self.fade_out);
        let frames = (self.len * FPS as f32).round() as usize;

        let screen = match footage_frame(&frame, ctx, self.file, frame.index, frames) {
            Some(href) => fframes::svgr!(<image x={CX} y={CY} width={CW} height={IMG_H} preserveAspectRatio="none" href={href} />),
            None => fframes::svgr!(<rect x={CX} y={CY} width={CW} height={CH} fill="#000" />),
        };

        let (zoom, sx, sy) = camera_at(self.cams, t);
        let fx = CX + sx * K;
        let fy = CY + sy * K;
        let (hw, hh) = (CW / 2.0 / zoom, CH / 2.0 / zoom);
        let fx = fx.clamp(CX + hw, CX + CW - hw);
        let fy = fy.clamp(CY + hh, CY + CH - hh);
        let camera = format!("translate({} {}) scale({})", CX + CW / 2.0 - zoom * fx, CY + CH / 2.0 - zoom * fy, zoom);

        let rings: Vec<Svgr> = self
            .rings
            .iter()
            .map(|&(s, e, x, y, w, h)| {
                let o = window_opacity(&frame, s, e);
                fframes::svgr!(
                    <rect x={CX + x * K} y={CY + y * K} width={w * K} height={h * K}
                          rx="8" fill="none" stroke={YELLOW} stroke-width={3.0 / zoom} opacity={o} />
                )
            })
            .collect();

        let caption_svgs: Vec<Svgr> = self
            .captions
            .iter()
            .map(|&(s, e, text)| {
                // Keep each caption inside this shot's own time, so captions of consecutive
                // shots swap instead of overlapping during the cross-fade.
                let o = window_opacity(&frame, s.max(0.35), e.min(total - 0.15));
                caption(&mut frame, ctx, text, 1022.0, o)
            })
            .collect();

        let badge = if self.speed > 1.0 {
            let label = format!("{}× speed", self.speed);
            fframes::svgr!(
                <g>
                    <rect x="1600" y="68" width="116" height="32" rx="16" fill={ACCENT} fill-opacity="0.18" stroke={ACCENT} stroke-opacity="0.5" />
                    <text x="1658" y="91" text-anchor="middle" font-family={SANS} font-weight="700" font-size="18" fill={ACCENT}>{label}</text>
                </g>
            )
        } else {
            Svgr::empty()
        };

        let clip_id = format!("clip-{}", self.name);
        let clip_url = format!("url(#{clip_id})");
        fframes::svgr!(
            <g opacity={opacity}>
                <defs>
                    <clipPath id={clip_id}>
                        <path d={format!("M{CX} {CY} H{} V{} Q{} {} {} {} H{} Q{CX} {} {CX} {} Z",
                            CX + CW, CY + CH - 16.0, CX + CW, CY + CH, CX + CW - 16.0, CY + CH, CX + 16.0, CY + CH, CY + CH - 16.0)} />
                    </clipPath>
                </defs>
                {window_chrome(CX, CY - 44.0, CW, CH + 44.0, "T3 Code", self.chapter)}
                {badge}
                <g clip-path={clip_url}>
                    <g transform={camera}>
                        {screen}
                        {rings}
                    </g>
                </g>
                {caption_svgs}
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// Recap

#[derive(Debug)]
struct RecapScene;
const RECAP_SECONDS: f32 = 10.0;

impl Scene for RecapScene {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(RECAP_SECONDS)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let opacity = scene_opacity(&frame, RECAP_SECONDS + XFADE, true, false);
        let steps: Vec<Svgr> = [
            ("node scripts/fork/install-desktop.ts", "the T3 Code fork's desktop app"),
            ("agentctl ssh-config install", "so SSH reaches agentctl-NAME"),
            ("New Sandbox → your manifests folder", "e.g. altinn-studio, with access: ssh"),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (cmd, what))| {
            let p = ease_out(&frame, 0.5 + i as f32 * 0.35);
            let y = 360.0 + i as f32 * 150.0;
            fframes::svgr!(
                <g opacity={p} transform={format!("translate({} 0)", (1.0 - p) * 40.0)}>
                    <circle cx="440" cy={y} r="34" fill="#1e2440" stroke={ACCENT} stroke-width="2" />
                    <text x="440" y={y + 12.0} text-anchor="middle" font-family={SANS} font-weight="700" font-size="32" fill={ACCENT}>{format!("{}", i + 1)}</text>
                    <text x="510" y={y - 4.0} font-family={MONO} font-weight="500" font-size="34" fill={TEXT}>{cmd}</text>
                    <text x="510" y={y + 38.0} font-family={SANS} font-weight="400" font-size="24" fill={MUTED}>{what}</text>
                </g>
            )
        })
        .collect();
        let links = ease_out(&frame, 1.8);
        fframes::svgr!(
            <g opacity={opacity}>
                <text x="960" y="200" text-anchor="middle" font-family={SANS} font-weight="700" font-size="60" fill={TEXT}
                      opacity={ease_out(&frame, 0.1)}>"That's the whole setup"</text>
                {steps}
                <g opacity={links}>
                    <text x="960" y="880" text-anchor="middle" font-family={MONO} font-weight="400" font-size="26" fill={MUTED}>"github.com/martinothamar/t3code"</text>
                    <text x="960" y="926" text-anchor="middle" font-family={MONO} font-weight="400" font-size="26" fill={MUTED}>"github.com/Altinn/altinn-studio/tree/main/agents"</text>
                </g>
            </g>
        )
    }
}
