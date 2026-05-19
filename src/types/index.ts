// Shared types for nagent v0.1.

export type Iso = string;

export interface NodeIdentity {
  nodeId: string;
  nodeName: string;
  ed25519Pub: string;
  createdAt: Iso;
}

export interface Peer {
  nodeName: string;
  pubKey: string;
  addresses: string[];
  roles: string[];
  lastSeen?: Iso;
}

export interface NetMeta {
  netId: string;
  name: string;
  createdAt: Iso;
  originNode: string;
}

export interface Project {
  projectId: string;
  name: string;
  netId: string;
  createdAt: Iso;
  createdByNode: string;
  description?: string;
}

export interface ProjectMarker {
  version: 1;
  netId: string;
  projectId: string;
  projectName: string;
  createdAt: Iso;
  createdByNode: string;
}

export interface SessionMeta {
  sessionId: string;
  name: string;
  projectId?: string;
  createdAt: Iso;
  roles: string[];
}

export interface ActiveState {
  activeNetId?: string;
  activeProjectId?: string;
}

// ----- Bus frames -----

export type BusAddress = string;

export interface HelloFrame {
  verb: "HELLO";
  node: string;
  session?: string;
  project?: string;
  asCli: boolean;
}

export interface SendFrame {
  verb: "SEND";
  to: BusAddress;
  payload: unknown;
  msgId: string;
  replyTo?: string;
  hops: number;
}

export interface RecvFrame {
  verb: "RECV";
  from: BusAddress;
  payload: unknown;
  msgId: string;
  inReplyTo?: string;
}

export interface SubscribeFrame {
  verb: "SUBSCRIBE";
  pattern: string;
}

export interface ListFrame {
  verb: "LIST";
  filter?: { project?: string; all?: boolean };
}

export interface ListResultEntry {
  name: string;
  address: string;
  project?: string;
  attached: number;
  roles: string[];
  createdAt: Iso;
}

export interface ListResultFrame {
  verb: "LIST_RESULT";
  sessions: ListResultEntry[];
}

export interface AckFrame {
  verb: "ACK";
  msgId: string;
}

export interface RegisterRoleFrame {
  verb: "REGISTER_ROLE";
  session: string;
  role: string;
}

export interface RecvDroppedFrame {
  verb: "RECV_DROPPED";
  reason: "queue-overflow";
  dropped: number;
}

export interface ErrorFrame {
  verb: "ERROR";
  message: string;
  code?: string;
}

export interface OkFrame {
  verb: "OK";
  echo?: unknown;
}

export interface CreateSessionFrame {
  verb: "CREATE_SESSION";
  name: string;
  projectId?: string;
}

export interface CloseSessionFrame {
  verb: "CLOSE_SESSION";
  name: string;
}

export interface SessionCreatedFrame {
  verb: "SESSION_CREATED";
  session: SessionMeta;
}

export interface SessionClosedFrame {
  verb: "SESSION_CLOSED";
  name: string;
}

export type BusFrame =
  | HelloFrame
  | SendFrame
  | RecvFrame
  | SubscribeFrame
  | ListFrame
  | ListResultFrame
  | AckFrame
  | RegisterRoleFrame
  | RecvDroppedFrame
  | ErrorFrame
  | OkFrame
  | CreateSessionFrame
  | CloseSessionFrame
  | SessionCreatedFrame
  | SessionClosedFrame;
