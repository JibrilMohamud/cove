/* eslint-disable prettier/prettier -- Initial music discovery UI follows the existing SoundtrackLibrary style until layout normalization. */
/** Editorial mood stations: discovery hints, never rights grants or playback licenses. */
export type CoveSoundsStation = {
  slug: string;
  title: string;
  atmosphere: string;
  description: string;
  accent: string;
  moods: readonly string[];
  instruments: readonly string[];
  books: readonly { title: string; author: string }[];
};
export const COVE_SOUNDS_STATIONS: readonly CoveSoundsStation[] = [
  { slug: "gothic-hour", title: "The Gothic Hour", atmosphere: "Haunting · Curious · Midnight", description: "Stormlit libraries, forbidden knowledge and beautiful monsters.", accent: "#75648e", moods: ["dark", "melancholy", "mysterious", "dramatic"], instruments: ["piano", "cello", "violin"], books: [{ title: "Frankenstein", author: "Mary Shelley" }, { title: "Dracula", author: "Bram Stoker" }, { title: "The Picture of Dorian Gray", author: "Oscar Wilde" }] },
  { slug: "letters-never-sent", title: "Letters Never Sent", atmosphere: "Tender · Romantic · Nostalgic", description: "Ballroom glances, impossible confessions, feelings left on the page.", accent: "#b47a86", moods: ["romantic", "gentle", "warm", "nostalgic"], instruments: ["piano", "violin", "harp"], books: [{ title: "Pride and Prejudice", author: "Jane Austen" }, { title: "Persuasion", author: "Jane Austen" }, { title: "Jane Eyre", author: "Charlotte Brontë" }] },
  { slug: "beyond-the-old-woods", title: "Beyond the Old Woods", atmosphere: "Wonder · Folklore · Adventure", description: "The other side of the forest is closer than you think.", accent: "#528078", moods: ["dreamy", "magical", "mysterious", "playful"], instruments: ["harp", "flute", "strings"], books: [{ title: "The Wonderful Wizard of Oz", author: "L. Frank Baum" }, { title: "The Princess and the Goblin", author: "George MacDonald" }] },
  { slug: "rainlit-library", title: "Rainlit Library", atmosphere: "Quiet · Cozy · Reflective", description: "A lamp, a window, steady rain, and nowhere else to be.", accent: "#6d8c9e", moods: ["calm", "peaceful", "gentle", "reflective"], instruments: ["piano", "cello", "harp"], books: [{ title: "Little Women", author: "Louisa May Alcott" }, { title: "Anne of Green Gables", author: "L. M. Montgomery" }] },
  { slug: "the-long-voyage", title: "The Long Voyage", atmosphere: "Restless · Epic · Open Water", description: "Uncharted currents and the longing to see what's over the horizon.", accent: "#4a7893", moods: ["adventurous", "dramatic", "triumphant"], instruments: ["strings", "violin", "piano"], books: [{ title: "Twenty Thousand Leagues Under the Seas", author: "Jules Verne" }, { title: "Treasure Island", author: "Robert Louis Stevenson" }] },
  { slug: "after-the-last-page", title: "After the Last Page", atmosphere: "Bittersweet · Solitary · Hopeful", description: "For stories that leave a little echo when they end.", accent: "#ae9069", moods: ["melancholy", "hopeful", "reflective", "gentle"], instruments: ["piano", "cello", "guitar"], books: [{ title: "The Secret Garden", author: "Frances Hodgson Burnett" }, { title: "A Christmas Carol", author: "Charles Dickens" }] },
];
export type CoveSoundsRecording = {
  id: string; title: string; composer: string; performer: string;
  moods: string[]; instruments: string[]; period: string; energy: number | null;
  hasVocals: boolean | null; audioUrl: string; attribution: string;
  license: string; licenseUrl: string; sourcePage: string;
};
/** Works only on the territory/rights-filtered /soundtracks/recordings response. */
export function stationRecordings(station: CoveSoundsStation, approved: readonly CoveSoundsRecording[]) {
  const score = (record: CoveSoundsRecording) => {
    if (record.hasVocals === true) return -1;
    const moods = record.moods.map((m) => m.toLowerCase());
    const instruments = record.instruments.map((m) => m.toLowerCase());
    const mood = station.moods.filter((m) => moods.some((v) => v.includes(m))).length;
    const instrument = station.instruments.filter((m) => instruments.some((v) => v.includes(m))).length;
    if (!mood && !instrument) return -1;
    return mood * 4 + instrument * 2 - Math.max(0, (record.energy ?? 0.4) - 0.65) * 3;
  };
  return approved
    .filter((r) => typeof r.audioUrl === "string" && r.audioUrl.startsWith("/api/fore/soundtracks/recordings/"))
    .map((r) => ({ recording: r, score: score(r) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.recording.id.localeCompare(b.recording.id))
    .slice(0, 8)
    .map((r) => r.recording);
}
export const stationBySlug = (slug: string) => COVE_SOUNDS_STATIONS.find((s) => s.slug === slug);
