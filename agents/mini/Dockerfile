FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ENV DEBIAN_FRONTEND=noninteractive

# What agentd needs from the image (systemd as init, OpenSSH for `access: ssh`, tmux for Sessions,
# sudo), and what Pi's tools reach for: Git, ripgrep and fd.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        fd-find \
        git \
        iproute2 \
        jq \
        less \
        openssh-server \
        procps \
        python3 \
        ripgrep \
        sudo \
        systemd \
        tmux \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
# Pi needs Node 22.19 or newer; T3 Code's server runs on the same Node.
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

ARG PI_VERSION=1.2.0
ARG CLAUDE_CODE_VERSION=2.1.296

# Pi is the agent T3 Code drives here; it installs without lifecycle scripts, as Pi documents.
# Claude Code backs the manifest's harness, which agentctl requires for its own Sessions, and
# needs its install script for the native binary. Node ignores the system trust store, where a
# build inside an Agent finds the network mediator's CA, unless told to use it.
RUN export NODE_OPTIONS=--use-openssl-ca \
    && npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && rm -rf /root/.npm \
    && pi --version \
    && claude --version

# The Agent user is the image's UID 1000 user, renamed.
RUN usermod --login agent --home /home/agent --move-home ubuntu \
    && groupmod --new-name agent ubuntu \
    && passwd --delete agent \
    && printf 'agent ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent \
    && install -d -m 0755 -o agent -g agent /home/agent/code /home/agent/.claude \
        /home/agent/.t3 /home/agent/.t3/userdata \
    && install -d -m 0700 -o agent -g agent /run/user/1000 \
    && test "$(id -u agent)" = 1000

COPY rootfs/ /
COPY --chown=agent:agent --chmod=0600 claude-state.json /home/agent/.claude/.claude.json
# T3 Code leaves Pi off until it is enabled. The image seeds that once, so the home overlay never
# overwrites settings changed later in the app.
COPY --chown=agent:agent --chmod=0600 t3-settings.json /home/agent/.t3/userdata/settings.json

# agentd owns the loopback SSH server policy and unit, so the distribution's own entry points and
# package-generated host keys go. Executions inherit init.scope, whose default task limit is too
# low for an agent and its tools at once. Ubuntu's pid_max default is invalid on the guest kernel
# and fails systemd-sysctl. The guest has no udev to activate hvc0, so its serial login would
# otherwise wait 90 seconds at boot.
RUN systemctl mask ssh.service ssh.socket serial-getty@hvc0.service \
    && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
    && install -d /etc/systemd/system/init.scope.d \
    && printf '[Scope]\nTasksMax=infinity\n' >/etc/systemd/system/init.scope.d/50-agent-tasks.conf \
    && ln -s /dev/null /etc/sysctl.d/50-pid-max.conf

ENV LANG=C.UTF-8
ENV DISABLE_AUTOUPDATER=1
ENV GH_NO_UPDATE_NOTIFIER=1
ENV HOME=/home/agent
ENV XDG_RUNTIME_DIR=/run/user/1000

USER agent
WORKDIR /home/agent/code
ENTRYPOINT ["/usr/lib/systemd/systemd"]
