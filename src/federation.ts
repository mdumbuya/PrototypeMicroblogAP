import { Accept, Follow, Endpoints, Person, Undo, Note,  PUBLIC_COLLECTION, createFederation, MemoryKvStore, InProcessMessageQueue, exportJwk, generateCryptoKeyPair, getActorHandle, importJwk, type Recipient } from "@fedify/fedify";

import { getLogger } from "@logtape/logtape";
import db from "./db.ts";
import type { Actor, User, Key, Post } from "./schema.ts";
import { Temporal } from "@js-temporal/polyfill";

const logger = getLogger("prototypeMicroblogAP");

const federation = createFederation({
  kv: new MemoryKvStore(),
  queue: new InProcessMessageQueue(),
});

federation
  .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
    const user = db
      .prepare<unknown[], User & Actor>(
        `
        SELECT * FROM users
        JOIN actors ON (users.id = actors.user_id)
        WHERE users.username = ?
        `,
      )
      .get(identifier);
    if (user == null) return null;

    const keys = await ctx.getActorKeyPairs(identifier);
    return new Person({
      id: ctx.getActorUri(identifier),
      preferredUsername: identifier,
      name: user.name,
      inbox: ctx.getInboxUri(identifier),
      endpoints: new Endpoints({
        sharedInbox: ctx.getInboxUri(),
      }),
      url: ctx.getActorUri(identifier),
      publicKey: keys[0].cryptographicKey,
      assertionMethods: keys.map((k) => k.multikey),
      followers: ctx.getFollowersUri(identifier),  
    });
  })
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    const user = db
      .prepare<unknown[], User>("SELECT * FROM users WHERE username = ?")
      .get(identifier);
    if (user == null) return [];
    const rows = db
      .prepare<unknown[], Key>("SELECT * FROM keys WHERE keys.user_id = ?")
      .all(user.id);
    const keys = Object.fromEntries(
      rows.map((row) => [row.type, row]),
    ) as Record<Key["type"], Key>;
    const pairs: CryptoKeyPair[] = [];
    // For each of the two key formats (RSASSA-PKCS1-v1_5 and Ed25519) that
    // the actor supports, check if they have a key pair, and if not,
    // generate one and store it in the database:
    for (const keyType of ["RSASSA-PKCS1-v1_5", "Ed25519"] as const) {
      if (keys[keyType] == null) {
        logger.debug(
          "The user {identifier} does not have an {keyType} key; creating one...",
          { identifier, keyType },
        );
        const { privateKey, publicKey } = await generateCryptoKeyPair(keyType);
        db.prepare(
          `
          INSERT INTO keys (user_id, type, private_key, public_key)
          VALUES (?, ?, ?, ?)
          `,
        ).run(
          user.id,
          keyType,
          JSON.stringify(await exportJwk(privateKey)),
          JSON.stringify(await exportJwk(publicKey)),
        );
        pairs.push({ privateKey, publicKey });
      } else {
        pairs.push({
          privateKey: await importJwk(
            JSON.parse(keys[keyType].private_key),
            "private",
          ),
          publicKey: await importJwk(
            JSON.parse(keys[keyType].public_key),
            "public",
          ),
        });
      }
    }
    return pairs;
  });

  federation
  .setInboxListeners("/users/{identifier}/inbox", "/inbox")
  .on(Follow, async (ctx, follow) => {
    if (follow.objectId == null) {
      logger.debug("The Follow object does not have an object: {follow}", {
        follow,
      });
      return;
    }
    const object = ctx.parseUri(follow.objectId);
    if (object == null || object.type !== "actor") {
      logger.debug("The Follow object's object is not an actor: {follow}", {
        follow,
      });
      return;
    }
    const follower = await follow.getActor();
    if (follower?.id == null || follower.inboxId == null) {
      logger.debug("The Follow object does not have an actor: {follow}", {
        follow,
      });
      return;
    }
    const followingId = db
      .prepare<unknown[], Actor>(
        `
        SELECT * FROM actors
        JOIN users ON users.id = actors.user_id
        WHERE users.username = ?
        `,
      )
      .get(object.identifier)?.id;
    if (followingId == null) {
      logger.debug(
        "Failed to find the actor to follow in the database: {object}",
        { object },
      );
    }
    const followerId = db
      .prepare<unknown[], Actor>(
        `
        -- Add a new follower actor record or update if it already exists
        INSERT INTO actors (uri, handle, name, inbox_url, shared_inbox_url, url)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (uri) DO UPDATE SET
          handle = excluded.handle,
          name = excluded.name,
          inbox_url = excluded.inbox_url,
          shared_inbox_url = excluded.shared_inbox_url,
          url = excluded.url
        WHERE
          actors.uri = excluded.uri
        RETURNING *
        `,
      )
      .get(
        follower.id.href,
        await getActorHandle(follower),
        follower.name?.toString(),
        follower.inboxId.href,
        follower.endpoints?.sharedInbox?.href,
        follower.url?.href,
      )?.id;
    db.prepare(
      "INSERT INTO follows (following_id, follower_id) VALUES (?, ?)",
    ).run(followingId, followerId);
    const accept = new Accept({
      actor: follow.objectId,
      to: follow.actorId,
      object: follow,
    });
    await ctx.sendActivity(object, follower, accept);
  }).on(Undo, async (ctx, undo) => {
    const object = await undo.getObject();
    if (!(object instanceof Follow)) return;
    if (undo.actorId == null || object.objectId == null) return;
    const parsed = ctx.parseUri(object.objectId);
    if (parsed == null || parsed.type !== "actor") return;
    db.prepare(
      `
      DELETE FROM follows
      WHERE following_id = (
        SELECT actors.id
        FROM actors
        JOIN users ON actors.user_id = users.id
        WHERE users.username = ?
      ) AND follower_id = (SELECT id FROM actors WHERE uri = ?)
      `,
    ).run(parsed.identifier, undo.actorId.href);
  });

  federation
  .setFollowersDispatcher(
    "/users/{identifier}/followers",
    (ctx, identifier, cursor) => {
      const followers = db
        .prepare<unknown[], Actor>(
          `
          SELECT followers.*
          FROM follows
          JOIN actors AS followers ON follows.follower_id = followers.id
          JOIN actors AS following ON follows.following_id = following.id
          JOIN users ON users.id = following.user_id
          WHERE users.username = ?
          ORDER BY follows.created DESC
          `,
        )
        .all(identifier);
      const items: Recipient[] = followers.map((f) => ({
        id: new URL(f.uri),
        inboxId: new URL(f.inbox_url),
        endpoints:
          f.shared_inbox_url == null
            ? null
            : { sharedInbox: new URL(f.shared_inbox_url) },
      }));
      return { items };
    },
  )
  .setCounter((ctx, identifier) => {
    const result = db
      .prepare<unknown[], { cnt: number }>(
        `
        SELECT count(*) AS cnt
        FROM follows
        JOIN actors ON actors.id = follows.following_id
        JOIN users ON users.id = actors.user_id
        WHERE users.username = ?
        `,
      )
      .get(identifier);
    return result == null ? 0 : result.cnt;
  });

federation.setObjectDispatcher(
  Note,
  "/users/{identifier}/posts/{id}",
  (ctx, values) => {
    const post = db
      .prepare<unknown[], Post>(
        `
        SELECT posts.*
        FROM posts
        JOIN actors ON actors.id = posts.actor_id
        JOIN users ON users.id = actors.user_id
        WHERE users.username = ? AND posts.id = ?
        `,
      )
      .get(values.identifier, values.id);
    if (post == null) return null;
    return new Note({
      id: ctx.getObjectUri(Note, values),
      attribution: ctx.getActorUri(values.identifier),
      to: PUBLIC_COLLECTION,
      cc: ctx.getFollowersUri(values.identifier),
      content: post.content,
      mediaType: "text/html",
      published: Temporal.Instant.from(`${post.created.replace(" ", "T")}Z`),
      url: ctx.getObjectUri(Note, values),
    });
  },
);

export default federation;
