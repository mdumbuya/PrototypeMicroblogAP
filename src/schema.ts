export interface User {
  id: number;
  username: string;
}

export interface Actor {
  id: number;
  user_id: number | null;
  uri: string;
  handle: string;
  name: string | null;
  inbox_url: string;
  shared_inbox_url: string | null;
  url: string | null;
  created: string;
}

export interface Key {
  user_id: number;
  type: "RSASSA-PKCS1-v1_5" | "Ed25519";
  private_key: string;
  public_key: string;
  created: string;
}