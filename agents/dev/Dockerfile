FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ENV DEBIAN_FRONTEND=noninteractive

# What agentd needs from the image (systemd as init, OpenSSH for `access: ssh`, tmux for Sessions,
# sudo), T3 Code's build tooling (ImageMagick resizes the desktop app's icons), Podman so a nested
# agentd can build Agent images, and a minimal desktop: Xtigervnc as X and VNC server in one
# process, openbox, tint2, and noVNC served by websockify for `agentctl vnc --web`. The `desktop`
# helper captures with ffmpeg and acts with xdotool; gnome-keyring is the Secret Service Electron's
# safeStorage needs. Inter and JetBrains Mono are the demo-video skill's fonts.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        dbus \
        ffmpeg \
        fonts-inter \
        fonts-jetbrains-mono \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-noto-core \
        git \
        gnome-keyring \
        imagemagick \
        iproute2 \
        jq \
        less \
        libnss3-tools \
        libsecret-1-dev \
        libsecret-tools \
        novnc \
        openbox \
        openssh-server \
        pkg-config \
        podman \
        podman-docker \
        procps \
        python3 \
        ripgrep \
        sakura \
        sudo \
        systemd \
        tigervnc-standalone-server \
        tint2 \
        tmux \
        unzip \
        websockify \
        x11-utils \
        x11-xserver-utils \
        xdotool \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
# The checkout requires Node 24 (package.json engines).
ARG NODE_VERSION=24.16.0
ARG GH_VERSION=2.100.0

RUN case "${TARGETARCH}" in \
        amd64) NODE_ARCH=x64; \
            GH_SHA256=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be ;; \
        arm64) NODE_ARCH=arm64; \
            GH_SHA256=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961 ;; \
        *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && NODE_SHA256="$(curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/SHASUMS256.txt" \
        | awk -v filename="${NODE_ARCHIVE}" '$2 == filename { print $1 }')" \
    && test -n "${NODE_SHA256}" \
    && curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}" -o /tmp/node.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
        --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md \
    && GH_ARCHIVE="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ARCHIVE}" -o /tmp/gh.tar.gz \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/node.tar.xz /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
    && node --version \
    && gh --version

# Route GitHub credentials through gh, so plain git authenticates with the mediated token.
RUN git config --system credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1
# Matches the repository's playwright-core, so tests and the desktop share one browser build.
ARG PLAYWRIGHT_VERSION=1.60.0
ARG AGENTCTL_VERSION=v0.1.0-preview.11
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Harnesses, a Chromium for the desktop (its system dependencies also cover Electron), and
# agentctl/agentd for developing the integration against nested Agents. The standalone agentctl
# install only places the binaries; agentd downloads its runtime on first use. Node ignores the
# system trust store, where a build inside an Agent finds the network mediator's CA, unless told
# to use it.
RUN export NODE_OPTIONS=--use-openssl-ca \
    && npm install --global \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
    && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && AGENT_INSTALL_MODE=standalone AGENT_VERSION="${AGENTCTL_VERSION}" AGENT_INSTALL_DIR=/usr/local/bin \
        sh -c "$(curl -fsSL https://raw.githubusercontent.com/digdir/digdir-agents/agentctl/${AGENTCTL_VERSION}/agentctl/install.sh)" \
    && claude --version \
    && codex --version \
    && agentctl --version

# The Agent user is the image's UID 1000 user, renamed. kvm lets a nested agentd start Sandboxes.
RUN { getent group kvm >/dev/null || groupadd --system kvm; } \
    && usermod --login agent --home /home/agent --move-home ubuntu \
    && groupmod --new-name agent ubuntu \
    && usermod --append --groups kvm agent \
    && passwd --delete agent \
    && printf 'agent ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent \
    && install -d -m 0755 -o agent -g agent /home/agent/code /home/agent/.claude \
    && install -d -m 0700 -o agent -g agent /run/user/1000 \
    && test "$(id -u agent)" = 1000

COPY rootfs/ /
COPY --chown=agent:agent --chmod=0600 claude-state.json /home/agent/.claude/.claude.json

# agentd owns the loopback SSH server policy and unit, so the distribution's own entry points and
# package-generated host keys go. Executions inherit init.scope, whose default task limit is too
# low for harnesses, dev servers and test runners at once; the same goes for inotify. Ubuntu's
# pid_max default is invalid on the guest kernel and fails systemd-sysctl. The guest
# has no udev to activate hvc0, so its serial login would otherwise wait 90 seconds at boot. The
# VNC access units ship disabled: agentd enables them for `access: [{type: vnc}]`.
RUN systemctl mask ssh.service ssh.socket serial-getty@hvc0.service \
    && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
    && install -d /etc/systemd/system/init.scope.d \
    && printf '[Scope]\nTasksMax=infinity\n' >/etc/systemd/system/init.scope.d/50-agent-tasks.conf \
    && printf 'fs.inotify.max_user_instances = 1024\nfs.inotify.max_user_watches = 1048576\nfs.inotify.max_queued_events = 32768\n' \
        >/usr/lib/sysctl.d/50-agent-inotify.conf \
    && ln -s /dev/null /etc/sysctl.d/50-pid-max.conf \
    && systemctl enable agent-workspace-init.service agent-ssh-config-init.service agent-browser-ca-init.service \
        agent-desktop-display.service agent-desktop-session.service agent-desktop-dbus.service \
        agent-desktop-keyring.service \
    && Xtigervnc -version 2>&1 | head -1 \
    && websockify --help >/dev/null \
    && test -f /usr/share/novnc/vnc.html \
    && chromium --headless --version \
    && xdotool --version \
    && desktop help >/dev/null

ENV LANG=C.UTF-8
ENV DISABLE_AUTOUPDATER=1
ENV GH_NO_UPDATE_NOTIFIER=1
ENV HOME=/home/agent
ENV XDG_RUNTIME_DIR=/run/user/1000
# Sessions are tmux processes rather than logins, so the desktop units provide the display and a
# session bus at fixed addresses. DISPLAY must match /etc/agent-desktop.conf.
ENV DISPLAY=:1
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
# agentd enables the Podman socket for the Agent user; Docker Engine API clients use it.
ENV DOCKER_HOST=unix:///run/podman/podman.sock

USER agent

# Vite+ (`vp`) drives installs, dev servers and tests. Node stays the system install above.
ARG VITE_PLUS_VERSION=1.0.0
ENV VP_HOME=/home/agent/.vite-plus
RUN curl -fsSL https://vite.plus -o /tmp/vite-plus-install.sh \
    && NODE_OPTIONS=--use-openssl-ca CI=1 VP_NODE_MANAGER=no VP_VERSION="${VITE_PLUS_VERSION}" bash /tmp/vite-plus-install.sh </dev/null \
    && rm -f /tmp/vite-plus-install.sh \
    && /home/agent/.vite-plus/bin/vp --version

# Rust builds the desktop app's native helpers under native/, whose edition 2024 needs a newer
# toolchain than Ubuntu ships. Sessions take PATH from ~/.profile rather than the image, so rustup
# adds itself there and to ~/.bashrc, as the Vite+ installer does.
ARG RUSTUP_VERSION=1.29.1
ARG RUST_VERSION=1.99.0
RUN case "${TARGETARCH}" in \
        amd64) RUST_ARCH=x86_64; \
            RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71 ;; \
        arm64) RUST_ARCH=aarch64; \
            RUSTUP_SHA256=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433 ;; \
        *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUST_ARCH}-unknown-linux-gnu/rustup-init" \
        -o /tmp/rustup-init \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && rm -f /tmp/rustup-init \
    && grep -q cargo/env /home/agent/.profile \
    && /home/agent/.cargo/bin/cargo --version
ENV PATH=/home/agent/.local/bin:/home/agent/.cargo/bin:/home/agent/.vite-plus/bin:${PATH}

WORKDIR /home/agent/code
ENTRYPOINT ["/usr/lib/systemd/systemd"]
