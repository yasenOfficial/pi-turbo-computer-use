# Build context is a freshly staged allowlist of daemon/{Cargo.toml,Cargo.lock,build.rs,src}.
# Trusted official upstream bases, major/minor version pinned; --pull takes
# patched images on the next explicitly authorized build (not bit-reproducible).
FROM rust:1.88-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /work/daemon
COPY daemon/ ./
RUN cargo build --release --locked && install -m 0755 target/release/pi-turbo-daemon /usr/local/bin/pi-turbo-daemon

FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    firefox-esr xvfb x11vnc novnc websockify openbox dbus-x11 at-spi2-core x11-utils \
    libglib2.0-bin libatk-bridge2.0-0 \
    libglib2.0-0 libx11-6 libxext6 libxfixes3 libxcb1 libxrender1 libxrandr2 \
    libxtst6 libxdamage1 ca-certificates fonts-dejavu-core passwd \
    && rm -rf /var/lib/apt/lists/*
# Build for the host user's numeric UID/GID so the IPC bind remains private,
# while NSS can resolve that UID for dbus-run-session, Firefox and Openbox.
ARG BROWSER_UID=1000
RUN groupadd --gid "$BROWSER_UID" browser && \
    useradd --uid "$BROWSER_UID" --gid "$BROWSER_UID" --home-dir /home/browser --no-create-home --shell /usr/sbin/nologin browser && \
    install -d -o "$BROWSER_UID" -g "$BROWSER_UID" -m 0700 /home/browser/profile
COPY --from=builder /usr/local/bin/pi-turbo-daemon /usr/local/bin/pi-turbo-daemon
COPY docker/browser/entrypoint.sh /usr/local/bin/browser-entrypoint
COPY docker/browser/session.sh /usr/local/bin/browser-session
COPY docker/browser/daemon-control.sh /usr/local/bin/browser-daemon-control
COPY docker/browser/profile-import.sh /usr/local/bin/browser-profile-import
RUN chmod 0755 /usr/local/bin/browser-entrypoint /usr/local/bin/browser-session /usr/local/bin/browser-daemon-control /usr/local/bin/browser-profile-import
LABEL org.pi-computer.browser.schema="persistent-noauth-v2"
ENV DISPLAY=:99 HOME=/home/browser XDG_RUNTIME_DIR=/run/user/browser XDG_SESSION_TYPE=x11 MOZ_ENABLE_WAYLAND=0 MOZ_ACCESSIBILITY_ENABLED=1 NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge GNOME_ACCESSIBILITY=1 ACCESSIBILITY_ENABLED=1 GSETTINGS_BACKEND=memory GTK_USE_PORTAL=0 TOKIO_WORKER_THREADS=2
USER ${BROWSER_UID}:${BROWSER_UID}
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/browser-entrypoint"]
