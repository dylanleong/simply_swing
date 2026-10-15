/**
 * The Help screen's content: how to use SimpleSwing, and what to look for in a swing. Plain text,
 * kept here so it's easy to edit and works offline.
 */

export type HelpSection = { heading: string; body: string };
export type HelpTopic = { id: HelpTopicId; title: string; summary: string; sections: HelpSection[] };
export type HelpTopicId = 'setup' | 'reading' | 'tags' | 'devices' | 'troubleshooting';

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'setup',
    title: 'Setting up the camera',
    summary: 'Where to put the phone so the video tells the truth.',
    sections: [
      {
        heading: 'Down the line (DTL)',
        body:
          'Stand the tripod behind you, about 3 m back, on a line through your hands that runs parallel ' +
          'to your target line. Camera at hand height, aimed at the target. If the camera sits outside ' +
          'or inside that line, the club looks steeper or flatter than it really is, and every plane ' +
          'line you draw will mislead you.',
      },
      {
        heading: 'Face on',
        body:
          'Square to your chest, about 3 m away, level with the ball or your sternum, at hand to chest ' +
          'height. This view shows sway, head movement, weight shift and the club at impact.',
      },
      {
        heading: 'Level and framing',
        body:
          'Keep the phone upright and level: a bar appears at the top of the Capture screen when it’s ' +
          'tilted, and turns green when it’s straight. Fit your whole body and the club at the top in ' +
          'the frame, with some space above your head. Use the normal 1× camera, not zoom.',
      },
      {
        heading: 'Light',
        body:
          'Slow motion needs light. Outdoors, keep the sun behind or beside the camera, not behind you. ' +
          'Turn on Settings → Sharp mode for a crisp club in daylight. Indoors, the brighter the better: ' +
          'dim rooms give grainy, blurred video.',
      },
    ],
  },
  {
    id: 'reading',
    title: 'Reading your swing',
    summary: 'What the drawing tools and tempo tell you.',
    sections: [
      {
        heading: 'Plane line (down the line)',
        body:
          'Pause at address and use Plane: drag along the shaft from the clubhead up through your hands. ' +
          'The line runs across the picture. Play the downswing: a shaft that comes down on or just under ' +
          'the line is on plane. Coming down above it (steeper, from outside) is "over the top", a common ' +
          'cause of pulls and slices. Dropping well under it can cause pushes and hooks.',
      },
      {
        heading: 'Head circle',
        body:
          'Use Circle around your head at address and watch it through the swing. A little movement away ' +
          'from the target in the backswing is normal. Moving towards the target before impact, or ' +
          'rising and dipping a lot, changes the low point of the swing: fat and thin shots.',
      },
      {
        heading: 'Posture and early extension (down the line)',
        body:
          'Draw a Line straight up and down touching your backside at address. If your hips move towards ' +
          'the ball and away from that line in the downswing, and you stand up, that’s early extension. ' +
          'It’s linked to thin shots, blocks and hooks.',
      },
      {
        heading: 'Angles',
        body:
          'Use Angle to measure your forward bend at address, then check you keep it through impact. ' +
          'Drag the first arm from the corner (say, your hip) up your spine, then tap the end of the ' +
          'second arm. It also works for knee flex and for the angle between your lead arm and the shaft ' +
          'at the top.',
      },
      {
        heading: 'Grid and mirror',
        body:
          'Grid lines make sway easy to see face on: watch your head and hips against the nearest line. ' +
          'Mirror flips the video, handy for comparing yourself with a golfer who swings the other way.',
      },
      {
        heading: 'Tempo',
        body:
          'With the watch sensing, each swing shows its tempo: backswing time ÷ downswing time. Many tour ' +
          'players are close to 3 : 1 (for example, a 0.75 s backswing and a 0.25 s downswing). Amateurs ' +
          'are often nearer 2 : 1, usually from rushing the transition. Your own number matters more than ' +
          'the tour’s: see what it is on your good shots, and whether your bad shots are quicker.',
      },
    ],
  },
  {
    id: 'tags',
    title: 'Tags, favourites and comparing',
    summary: 'Find the pattern behind your bad shots.',
    sections: [
      {
        heading: 'Tag as you go',
        body:
          'Pick your club with the Club button on the Capture screen; every swing you save is tagged with ' +
          'it. After each shot the replay asks "How was it?": one tap tags what the ball did and goes ' +
          'back to the camera. You can also tag later in review → Tag.',
      },
      {
        heading: 'Filter',
        body:
          'In Swings, tap Filter to show one club, one result or your favourites. Put your slices side by ' +
          'side and look for what they share: often it’s the same position at the top or in transition.',
      },
      {
        heading: 'Favourites and compare',
        body:
          'Star your best swing in review → Tag. Then open any other swing and choose Share → Compare ' +
          'with…: the two play side by side, lined up on impact. Step through the top of the backswing ' +
          'and impact frame by frame. Favourites are never auto-deleted.',
      },
    ],
  },
  {
    id: 'devices',
    title: 'Second phone, watch and remotes',
    summary: 'Two angles, wrist sensing and hands-free saving.',
    sections: [
      {
        heading: 'A second phone as a second camera',
        body:
          'Put both phones on the same Wi-Fi, or turn on one phone’s hotspot and join it from the other. ' +
          'On the second phone: Settings → Use this phone as the camera, and choose its view. On your ' +
          'phone: tap + Cam on the Capture screen and pick it. Keep SimpleSwing open on both. Every swing ' +
          'you save is filmed from both, and Save to Photos makes one side-by-side video.',
      },
      {
        heading: 'Wear OS watch',
        body:
          'Open SimpleSwing on the watch. With Settings → Watch → Sense swings, only shots where your ' +
          'wrist swung are saved (neighbours’ shots are ignored), each swing gets a tempo, and practice ' +
          'swings can be saved too. Or choose Tap to save, to use the watch as a remote.',
      },
      {
        heading: 'Volume buttons and Bluetooth remotes',
        body:
          'Pressing a volume button, or a cheap Bluetooth camera remote, works like SAVE: it keeps the last ' +
          'few seconds (Settings → Clip length).',
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'Missed shots, wrong shots, heat and storage.',
    sections: [
      {
        heading: 'My shot wasn’t saved',
        body:
          'Check AUTO is on. Tap the status pill to open Levels: a shot needs movement in the golfer box ' +
          'just before it, and a sound loud enough. Make the box cover where you stand and swing. If ' +
          'strikes read too quiet, raise Settings → Impact sensitivity. You can always tap SAVE after a ' +
          'swing.',
      },
      {
        heading: 'Someone else’s shot was saved',
        body:
          'Shrink the golfer box so it only covers you, lower Settings → Impact sensitivity, or wear the ' +
          'watch: with it sensing, only your own swings count.',
      },
      {
        heading: 'The second camera missed a swing',
        body:
          'Both phones must stay in SimpleSwing with the screen on. Right after either phone wakes from ' +
          'standby, give it a second before swinging.',
      },
      {
        heading: 'The phone gets hot',
        body:
          'In direct sun, recording at high frame rates warms the phone; SimpleSwing drops to 60 fps and ' +
          'tells you. Shade the phone, or choose 120 fps rather than 240.',
      },
      {
        heading: 'Storage',
        body:
          'A swing is about 10–30 MB. Settings → Storage can delete old swings automatically; favourites ' +
          'and anything you saved to Photos are kept.',
      },
    ],
  },
];

export const helpTopic = (id: string | undefined): HelpTopic | undefined => HELP_TOPICS.find((t) => t.id === id);
