import { homedir } from "node:os";
import { join } from "node:path";

const NAGENT_HOME_ENV = "NAGENT_HOME";

export function nagentRoot(): string {
  const override = process.env[NAGENT_HOME_ENV];
  if (override && override.length > 0) return override;
  return join(homedir(), ".nagent");
}

export function paths() {
  const root = nagentRoot();
  return {
    root,
    identity: join(root, "identity.json"),
    activeState: join(root, "active.json"),
    socket: join(root, "sock"),
    sessions: join(root, "sessions.json"),
    invites: join(root, "invites.json"),
    daemonLog: join(root, "daemon.log"),
    daemonPid: join(root, "daemon.pid"),
    sshDir: join(root, "ssh"),
    sshKey: join(root, "ssh", "nagent_ed25519"),
    sshPub: join(root, "ssh", "nagent_ed25519.pub"),
    netsDir: join(root, "nets"),
    netDir: (netId: string) => join(root, "nets", netId),
    netMeta: (netId: string) => join(root, "nets", netId, "meta.json"),
    netPeers: (netId: string) => join(root, "nets", netId, "peers.json"),
    netProjects: (netId: string) => join(root, "nets", netId, "projects.json"),
    netAuthority: (netId: string) => join(root, "nets", netId, "authority.json"),
    // v0.4 web hub
    webDir: join(root, "web"),
    webCert: join(root, "web", "cert.pem"),
    webKey: join(root, "web", "key.pem"),
    webConfig: join(root, "web.json"),
    webPid: join(root, "web", "hub.pid"),
    webKnownHubs: join(root, "web", "known_hubs.json"),
  };
}

export const TMUX_SOCKET_NAME = "nagent";
export const PROJECT_MARKER_FILE = ".nagent";
