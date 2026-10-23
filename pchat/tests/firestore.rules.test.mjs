/**
 * SHEPU ROOMS — Firestore Security Rules tests
 *
 * Run with:  npm run test:rules
 *
 * The tests start the Firestore emulator, load firestore.rules, and exercise
 * the friend-request accept path, profile visibility, invite permissions and
 * handle ownership. No production data is touched.
 */

import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';

const RULES = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081').split(':');

const testEnv = await initializeTestEnvironment({
  projectId: 'pchat-shepu',
  firestore: {
    rules: RULES,
    host,
    port: Number(port),
  },
});

const alice = testEnv.authenticatedContext('alice').firestore();
const bob = testEnv.authenticatedContext('bob').firestore();
const eve = testEnv.authenticatedContext('eve').firestore();
const anon = testEnv.unauthenticatedContext().firestore();

function profile(uid, friendUids = [], handle = '') {
  return {
    name: uid,
    handle,
    avatar: '',
    pubKey: null,
    friendUids,
    lastActiveAt: new Date(),
    flags: { showPresence: true },
    createdAt: new Date(),
  };
}

async function seedProfile(uid, friendUids = [], handle = '') {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), profile(uid, friendUids, handle));
  });
}

async function seedUsername(handle, uid) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usernames', handle), { uid });
  });
}

async function seedRequest(from, to) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'friendRequests', `${from}_${to}`), {
      from,
      to,
      status: 'pending',
      fromName: from,
      createdAt: new Date(),
    });
  });
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await testEnv.clearFirestore();
    await fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.error('  \u2717 ' + name);
    console.error('    ' + ((e && e.message) || e));
  }
}

function section(name) {
  console.log('\n' + name);
}

// ── Profiles ────────────────────────────────────────────────────
section('Profiles');

await test('self can create a profile with an empty friendUids', async () => {
  await assertSucceeds(setDoc(doc(alice, 'users', 'alice'), profile('alice')));
});

await test('self cannot pre-fill friendUids on create', async () => {
  await assertFails(setDoc(doc(alice, 'users', 'alice'), profile('alice', ['bob'])));
});

await test('stranger cannot read a profile', async () => {
  await seedProfile('alice');
  await assertFails(getDoc(doc(eve, 'users', 'alice')));
});

await test('friend can read a profile', async () => {
  await seedProfile('alice', ['bob']);
  await assertSucceeds(getDoc(doc(bob, 'users', 'alice')));
});

await test('unauthenticated cannot read a profile', async () => {
  await seedProfile('alice');
  await assertFails(getDoc(doc(anon, 'users', 'alice')));
});

await test('self can update presence while keeping the handle unchanged', async () => {
  await seedProfile('alice', [], 'alice_1');
  await assertSucceeds(updateDoc(doc(alice, 'users', 'alice'), { lastActiveAt: new Date() }));
});

await test('self can claim a handle backed by their username document', async () => {
  await seedProfile('alice');
  await seedUsername('alice_1', 'alice');
  await assertSucceeds(updateDoc(doc(alice, 'users', 'alice'), { handle: 'alice_1' }));
});

await test('self cannot claim a handle backed by another user', async () => {
  await seedProfile('alice');
  await seedUsername('bob_1', 'bob');
  await assertFails(updateDoc(doc(alice, 'users', 'alice'), { handle: 'bob_1' }));
});

await test('self cannot claim an unindexed handle', async () => {
  await seedProfile('alice');
  await assertFails(updateDoc(doc(alice, 'users', 'alice'), { handle: 'alice_1' }));
});

await test('self cannot change a claimed handle', async () => {
  await seedProfile('alice', [], 'alice_1');
  await seedUsername('bob_1', 'alice');
  await assertFails(updateDoc(doc(alice, 'users', 'alice'), { handle: 'bob_1' }));
});

// ── Friend requests ─────────────────────────────────────────────
section('Friend requests');

await test('sender can probe a missing request before creating it', async () => {
  await assertSucceeds(getDoc(doc(bob, 'friendRequests', 'bob_alice')));
});

await test('can create a canonical request', async () => {
  await assertSucceeds(setDoc(doc(bob, 'friendRequests', 'bob_alice'), {
    from: 'bob',
    to: 'alice',
    status: 'pending',
    fromName: 'Bob',
    fromHandle: 'bob_1',
    toHandle: 'alice_1',
    createdAt: new Date(),
  }));
});

await test('cannot create an oversized request payload', async () => {
  await assertFails(setDoc(doc(bob, 'friendRequests', 'bob_alice'), {
    from: 'bob',
    to: 'alice',
    status: 'pending',
    fromName: 'x'.repeat(81),
    fromHandle: 'bob_1',
    toHandle: 'alice_1',
    createdAt: new Date(),
  }));
});

await test('cannot create a request with unexpected fields', async () => {
  await assertFails(setDoc(doc(bob, 'friendRequests', 'bob_alice'), {
    from: 'bob',
    to: 'alice',
    status: 'pending',
    fromName: 'Bob',
    fromHandle: 'bob_1',
    toHandle: 'alice_1',
    createdAt: new Date(),
    junk: 'x'.repeat(1000),
  }));
});

await test('cannot create a request with a mismatched document id', async () => {
  await assertFails(setDoc(doc(bob, 'friendRequests', 'not-canonical'), {
    from: 'bob',
    to: 'alice',
    status: 'pending',
    fromName: 'Bob',
    createdAt: new Date(),
  }));
});

await test('cannot forge a request from another user', async () => {
  await assertFails(setDoc(doc(eve, 'friendRequests', 'bob_alice'), {
    from: 'bob',
    to: 'alice',
    status: 'pending',
    fromName: 'Bob',
    createdAt: new Date(),
  }));
});

await test('sender cannot accept their own request', async () => {
  await seedRequest('bob', 'alice');
  await assertFails(updateDoc(doc(bob, 'friendRequests', 'bob_alice'), { status: 'accepted' }));
});

// ── Accept / unfriend ───────────────────────────────────────────
section('Accept / unfriend');

await test('recipient can add exactly themselves after a pending request', async () => {
  await seedProfile('bob');
  await seedProfile('alice');
  await seedRequest('bob', 'alice');

  await assertSucceeds(updateDoc(doc(alice, 'users', 'bob'), { friendUids: ['alice'] }));
  await assertSucceeds(updateDoc(doc(alice, 'users', 'alice'), { friendUids: ['bob'] }));
  await assertSucceeds(updateDoc(doc(alice, 'friendRequests', 'bob_alice'), { status: 'accepted' }));
});

await test('recipient cannot smuggle a third uid into the sender list', async () => {
  await seedProfile('bob');
  await seedRequest('bob', 'alice');
  await assertFails(updateDoc(doc(alice, 'users', 'bob'), { friendUids: ['alice', 'eve'] }));
});

await test('stranger cannot inject themselves without a request', async () => {
  await seedProfile('bob');
  await assertFails(updateDoc(doc(eve, 'users', 'bob'), { friendUids: ['eve'] }));
});

await test('friend can remove exactly themselves on unfriend', async () => {
  await seedProfile('bob', ['alice']);
  await assertSucceeds(updateDoc(doc(alice, 'users', 'bob'), { friendUids: [] }));
});

await test('recipient can accept and delete the request in one batch', async () => {
  await seedProfile('bob');
  await seedProfile('alice');
  await seedRequest('bob', 'alice');

  const batch = writeBatch(alice);
  batch.update(doc(alice, 'users', 'bob'), { friendUids: ['alice'] });
  batch.update(doc(alice, 'users', 'alice'), { friendUids: ['bob'] });
  batch.delete(doc(alice, 'friendRequests', 'bob_alice'));
  await assertSucceeds(batch.commit());

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'friendRequests', 'bob_alice'));
    if (snap.exists()) throw new Error('request should be deleted after accept');
  });
});

await test('recipient and sender can read their own request queries', async () => {
  await seedRequest('bob', 'alice');

  await assertSucceeds(getDocs(query(
    collection(alice, 'friendRequests'),
    where('to', '==', 'alice')
  )));
  await assertSucceeds(getDocs(query(
    collection(bob, 'friendRequests'),
    where('from', '==', 'bob')
  )));
});

await test('stranger cannot query someone else\'s requests', async () => {
  await seedRequest('bob', 'alice');

  await assertFails(getDocs(query(
    collection(eve, 'friendRequests'),
    where('to', '==', 'alice')
  )));
});

// ── Invites ─────────────────────────────────────────────────────
section('Invites');

await test('friend can create an encrypted invite for a friend', async () => {
  await seedProfile('alice', ['bob']);
  await assertSucceeds(setDoc(doc(bob, 'users', 'alice', 'invites', 'bob_room1'), {
    from: 'bob',
    roomId: 'room1',
    ciphertext: 'x',
    seen: false,
    createdAt: new Date(),
  }));
});

await test('non-friend cannot create an invite', async () => {
  await seedProfile('alice', []);
  await assertFails(setDoc(doc(eve, 'users', 'alice', 'invites', 'eve_room1'), {
    from: 'eve',
    roomId: 'room1',
    ciphertext: 'x',
    seen: false,
    createdAt: new Date(),
  }));
});

await test('invite document id must match sender + room', async () => {
  await seedProfile('alice', ['bob']);
  await assertFails(setDoc(doc(bob, 'users', 'alice', 'invites', 'wrong'), {
    from: 'bob',
    roomId: 'room1',
    ciphertext: 'x',
    seen: false,
    createdAt: new Date(),
  }));
});

await test('oversized invite ciphertext is rejected', async () => {
  await seedProfile('alice', ['bob']);
  await assertFails(setDoc(doc(bob, 'users', 'alice', 'invites', 'bob_room1'), {
    from: 'bob',
    roomId: 'room1',
    ciphertext: 'x'.repeat(4001),
    seen: false,
    createdAt: new Date(),
  }));
});

await test('invite must be unseen at creation', async () => {
  await seedProfile('alice', ['bob']);
  await assertFails(setDoc(doc(bob, 'users', 'alice', 'invites', 'bob_room1'), {
    from: 'bob',
    roomId: 'room1',
    ciphertext: 'x',
    seen: true,
    createdAt: new Date(),
  }));
});

await test('invite cannot carry unexpected fields', async () => {
  await seedProfile('alice', ['bob']);
  await assertFails(setDoc(doc(bob, 'users', 'alice', 'invites', 'bob_room1'), {
    from: 'bob',
    roomId: 'room1',
    ciphertext: 'x',
    seen: false,
    createdAt: new Date(),
    link: 'https://example.com/room',
  }));
});

await test('only the recipient can read the invite', async () => {
  await seedProfile('alice', ['bob']);
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'alice', 'invites', 'bob_room1'), {
      from: 'bob',
      roomId: 'room1',
      ciphertext: 'x',
      createdAt: new Date(),
    });
  });

  await assertSucceeds(getDoc(doc(alice, 'users', 'alice', 'invites', 'bob_room1')));
  await assertFails(getDoc(doc(bob, 'users', 'alice', 'invites', 'bob_room1')));
});

// ── Usernames ───────────────────────────────────────────────────
section('Usernames');

await test('owner can claim a valid handle', async () => {
  await assertSucceeds(setDoc(doc(alice, 'usernames', 'alice_1'), { uid: 'alice' }));
});

await test('cannot claim a handle for someone else', async () => {
  await assertFails(setDoc(doc(bob, 'usernames', 'alice_1'), { uid: 'alice' }));
});

await test('handle must match the allowed pattern', async () => {
  await assertFails(setDoc(doc(alice, 'usernames', 'AL'), { uid: 'alice' }));
});

await test('handle cannot be overwritten', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usernames', 'alice_1'), { uid: 'alice' });
  });
  await assertFails(setDoc(doc(bob, 'usernames', 'alice_1'), { uid: 'bob' }));
});

await test('owner can delete their handle', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usernames', 'alice_1'), { uid: 'alice' });
  });
  await assertSucceeds(deleteDoc(doc(alice, 'usernames', 'alice_1')));
});

console.log(`\n${passed} passed, ${failed} failed`);
await testEnv.cleanup();
process.exitCode = failed ? 1 : 0;
