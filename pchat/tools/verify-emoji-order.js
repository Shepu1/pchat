#!/usr/bin/env node
/**
 * Verifies the emoji picker's display order (js/custom-emoji.js).
 *
 * The picker used to be alphabetical by file name, which scattered related
 * faces, put lip_10 before lip_2, and mixed vegetables into fruit. The
 * loader now groups each category by meaning. This suite loads the real
 * module against assets/emoji/index.json and checks the resulting order.
 */
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (x ? '  → ' + x : ''))); };

const index = JSON.parse(fs.readFileSync('assets/emoji/index.json', 'utf8'));
const src = fs.readFileSync('js/custom-emoji.js', 'utf8');

const ctx = {
  console,
  fetch: async (url) => {
    if (!String(url).endsWith('index.json')) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => index };
  },
  document: { addEventListener() {} },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'js/custom-emoji.js' });

const CE = ctx.CustomEmoji;

function files(cat) {
  return CE.itemsByCategory(cat).map(it => it.file);
}
function at(cat, file) {
  return files(cat).indexOf(file);
}
function before(cat, a, b) {
  const x = at(cat, a), y = at(cat, b);
  return x >= 0 && y >= 0 && x < y;
}

(async () => {
  await CE.load();

  // ── Structure ────────────────────────────────────────────────
  const cats = CE.categories();
  ck('53 categories listed (All + 17)', cats.length === 18 && cats[0] === 'All', cats.join(', '));
  ck('item count matches index.json', CE.count() === index.length, CE.count() + ' vs ' + index.length);

  const expected = new Map();
  for (const it of index) {
    if (!expected.has(it.category)) expected.set(it.category, []);
    expected.get(it.category).push(it.file);
  }
  for (const cat of cats.slice(1)) {
    const list = files(cat);
    const want = expected.get(cat) || [];
    ck(cat + ': every item exactly once', list.length === want.length && new Set(list).size === list.length && want.every(f => list.includes(f)),
      list.length + ' / ' + want.length);
  }

  const flat = CE.itemsByCategory('All').map(it => it.file);
  const concat = cats.slice(1).flatMap(c => files(c));
  ck('All view = categories in order', flat.length === concat.length && flat.every((f, i) => f === concat[i]));

  // ── Natural numbering ────────────────────────────────────────
  ck('romantic: lip_2 before lip_10', before('romantic', 'lip_2.png', 'lip_10.png'));
  ck('romantic: lips 1–24 in exact order',
    files('romantic').slice(0, 24).every((f, i) => f === 'lip_' + (i + 1) + '.png'),
    files('romantic').slice(0, 24).join(', '));
  ck('love: 10_flaming_heart before colour hearts', before('love', '10_flaming_heart.png', 'black_heart.png'));
  ck('love: 07_broken_heart after 06_revolving_hearts', before('love', '06_revolving_hearts.png', '07_broken_heart.png'));

  // ── face ─────────────────────────────────────────────────────
  ck('face: starts with a happy face', at('face', 'big_toothy_grin.png') === 0);
  ck('face: happy before love', before('face', 'star-struck.png', 'embarrassed-blushing-face.png'));
  ck('face: love before playful', before('face', 'kissing_face.png', 'clown-face.png'));
  ck('face: playful before sad', before('face', 'zipper-mouth-face.png', 'anxious_face_with_sweat.png'));
  ck('face: sad-relieved stays in sad', before('face', 'crying_face.png', 'sad-relieved.png') && before('face', 'sad-relieved.png', 'angry_face.png'));
  ck('face: sad before angry', before('face', 'worried-face.png', 'angry_face.png'));
  ck('face: angry before surprised', before('face', 'unamused-side-eye-face.png', 'astonished_shocked_face.png'));
  ck('face: surprised before confused', before('face', 'woozy_face.png', 'confounded.png'));
  ck('face: confused before tired', before('face', 'thinking_face.png', 'drooling-face.png'));
  ck('face: tired before other', before('face', 'yawning-sleepy-face.png', 'blackmoon.png'));
  ck('face: ends with skull', files('face').slice(-1)[0] === 'skull.png');
  ck('face: kissing-with-smiling is grouped with kisses', at('face', 'kissing_face_with_smiling_eyes.png') >= 16);

  // ── animal ───────────────────────────────────────────────────
  ck('animal: pets before wild', before('animal', 'teddy_bear.png', 'bear.png'));
  ck('animal: wild before birds', before('animal', 'speak_no_evil_monkey.png', 'butterfly.png'));
  ck('animal: birds before sea', before('animal', 'spider.png', 'dolphin.png'));
  ck('animal: sea before fantasy', before('animal', 'whale.png', 'dragon.png'));
  ck('animal: fantasy before other', before('animal', 'unicorn.png', 'frog.png'));
  ck('animal: ends with snake', files('animal').slice(-1)[0] === 'snake.png');

  // ── drinks / festival / fruit ────────────────────────────────
  ck('drinks: starts with bubble tea', at('drinks', 'bubble_tea.png') === 0);
  ck('drinks: hot before cold', before('drinks', 'stylish_teapot.png', 'coconut_drink.png'));
  ck('drinks: soft drinks before water', before('drinks', 'soda_can.png', 'glass_of_water.png'));
  ck('drinks: ends with water bottle', files('drinks').slice(-1)[0] === 'water_bottle.png');

  ck('festival: starts with birthday cake', at('festival', 'birthday-cake.png') === 0);
  ck('festival: party before gifts', before('festival', 'party-popper.png', 'heart-shaped-gift-box.png'));
  ck('festival: gifts before seasonal', before('festival', 'wrapped-gift-box.png', 'celebration-wreath.png'));
  ck('festival: seasonal before lights', before('festival', 'snowman.png', 'crescent-moon-lantern.png'));
  ck('festival: ends with fireworks', files('festival').slice(-1)[0] === 'festive-fireworks.png');

  ck('fruit: fruits before vegetables', before('fruit', 'watermelon.png', 'broccoli.png'));
  ck('fruit: tomato is a vegetable here', files('fruit').slice(-1)[0] === 'tomato.png');

  // ── love ─────────────────────────────────────────────────────
  ck('love: colour hearts before symbols', before('love', 'yellow_heart.png', '11_sealed_love_letter.png'));
  ck('love: 16_engagement_ring before hug', before('love', '16_engagement_ring.png', 'hug.png'));
  ck('love: ends with hug', files('love').slice(-1)[0] === 'hug.png');

  // ── medical ──────────────────────────────────────────────────
  ck('medical: care before hygiene', before('medical', 'wheelchair.png', 'bar_of_soap.png'));
  ck('medical: hygiene before body', before('medical', 'toothbrush.png', 'brain.png'));
  ck('medical: brain last', files('medical').slice(-1)[0] === 'brain.png');

  // ── music&games ──────────────────────────────────────────────
  ck('music&games: music before games', before('music&games', 'snare_drum.png', 'arcade_joystick.png'));
  ck('music&games: games before art/film', before('music&games', 'pair_of_dice.png', 'artists_palette.png'));
  ck('music&games: ends with film camera', files('music&games').slice(-1)[0] === 'vintage_film_camera.png');

  // ── nature ───────────────────────────────────────────────────
  ck('nature: sunflower is with plants, not sky', before('nature', 'sunflower.png', 'radiant_sun.png'));
  ck('nature: plants before sky', before('nature', 'tulip.png', 'crescent_moon.png'));
  ck('nature: sky before land/sea', before('nature', 'umbrella_with_raindrops.png', 'glowing_flame.png'));
  ck('nature: ends with ocean wave', files('nature').slice(-1)[0] === 'ocean_wave.png');

  // ── people ───────────────────────────────────────────────────
  ck('people: family before everyday', before('people', 'smiling_child.png', 'friendly_adult.png'));
  ck('people: actions before reactions', before('people', 'speaking_head.png', 'man_facepalming.png'));
  ck('people: ends with woman shrugging', files('people').slice(-1)[0] === 'woman_shrugging.png');

  // ── romantic ─────────────────────────────────────────────────
  ck('romantic: lips before flirt', before('romantic', 'steamy_kiss_mark.png', 'blushing_desire.png'));
  ck('romantic: flirt before romance objects', before('romantic', 'whispering_couple.png', 'heart_on_fire.png'));
  ck('romantic: ends with silk-tied heart', files('romantic').slice(-1)[0] === 'silk_tied_heart.png');

  // ── rood ─────────────────────────────────────────────────────
  ck('rood: meals before sweets', before('rood', 'taco.png', 'cake_slice.png'));
  ck('rood: sweets before extras', before('rood', 'wrapped_candy.png', 'cheese_wedge.png'));
  ck('rood: ends with honey', files('rood').slice(-1)[0] === 'honey_jar.png');

  // ── symbol ───────────────────────────────────────────────────
  ck('symbol: marks before locks', before('symbol', 'warning_triangle.png', 'closed_padlock.png'));
  ck('symbol: mail before money', before('symbol', 'thought_bubble.png', 'flying_money.png'));
  ck('symbol: objects before places', before('symbol', 'wastebasket.png', 'map_pin.png'));
  ck('symbol: places before shapes', before('symbol', 'red_flag.png', 'blue_circle.png'));
  ck('symbol: ends with yellow circle', files('symbol').slice(-1)[0] === 'yellow_circle.png');

  // ── technology ───────────────────────────────────────────────
  ck('technology: time before computers', before('technology', 'stopwatch.png', 'computer_mouse.png'));
  ck('technology: audio before cameras (headphones are not phones)', before('technology', 'wireless_earbuds.png', 'camera_drone.png'));
  ck('technology: ends with VR headset', files('technology').slice(-1)[0] === 'virtual_reality_headset.png');

  // ── vehicle ──────────────────────────────────────────────────
  ck('vehicle: road before rail', before('vehicle', 'yellow-taxi.png', 'passenger-train.png'));
  ck('vehicle: rail before air', before('vehicle', 'subway-train.png', 'commercial-airplane.png'));
  ck('vehicle: ends with sailboat', files('vehicle').slice(-1)[0] === 'sailboat.png');

  // ── hand ─────────────────────────────────────────────────────
  ck('hand: pointing before open hands', before('hand', 'point_right.png', 'back_of_hand.png'));
  ck('hand: fists before thumbs', before('hand', 'right_facing_fist.png', 'thumbs_down.png'));
  ck('hand: pinch before signs', before('hand', 'pinching_hand.png', 'crossed_fingers.png'));
  ck('hand: middle finger last', files('hand').slice(-1)[0] === 'middle_finger.png');

  // ── pchat ────────────────────────────────────────────────────
  ck('pchat: food/culture before reactions', before('pchat', 'samosa_mascot.png', 'battery_tired_face.png'));
  ck('pchat: hands before objects', before('pchat', 'rightwards_hand.png', 'glossy_megaphone.png'));
  ck('pchat: ends with red status light', files('pchat').slice(-1)[0] === 'red_status_light.png');

  // ── Search uses the same order ───────────────────────────────
  const searchFace = CE.search('', 'face').map(it => it.file);
  ck('search("", category) keeps picker order', searchFace.length === 101 && searchFace.every((f, i) => f === files('face')[i]));
  ck('empty search over All keeps picker order', CE.search('', 'All').map(it => it.file).every((f, i) => f === flat[i]));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
