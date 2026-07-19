/** Partial types for the osu! v2 API ("solo score" format, x-api-version >= 20220705). */

export interface ApiMod {
  acronym: string;
  settings?: Record<string, unknown>;
}

export interface SoloScore {
  id: number;
  legacy_score_id: number | null;
  user_id: number;
  beatmap_id: number;
  ruleset_id: number;
  ended_at: string;
  rank: string; // XH X SH S A B C D (X = SS, XH = SS silver)
  accuracy: number;
  max_combo: number;
  total_score: number; // lazer standardised
  legacy_total_score: number | null; // converted ScoreV1 (stable scores)
  classic_total_score?: number;
  pp: number | null;
  is_perfect_combo: boolean;
  legacy_perfect?: boolean | null;
  passed: boolean;
  mods: ApiMod[];
  statistics: Record<string, number>;
  maximum_statistics?: Record<string, number>;
  user?: { id: number; username: string };
  beatmap?: ApiBeatmap;
  beatmapset?: ApiBeatmapset;
}

export interface ApiBeatmap {
  id: number;
  beatmapset_id: number;
  mode_int: number;
  version: string;
  ranked: number;
  total_length: number;
  hit_length: number;
  bpm: number;
  cs: number;
  ar: number;
  accuracy: number; // OD
  drain: number; // HP
  difficulty_rating: number;
  max_combo?: number;
  count_circles?: number;
  count_sliders?: number;
  count_spinners?: number;
  last_updated?: string;
  beatmapset?: ApiBeatmapset;
}

export interface ApiBeatmapset {
  id: number;
  artist: string;
  artist_unicode?: string;
  title: string;
  title_unicode?: string;
  creator: string;
  user_id: number;
  source?: string;
  tags?: string;
  ranked: number;
  ranked_date?: string | null;
  submitted_date?: string | null;
  availability?: {
    download_disabled?: boolean;
    more_information?: string | null;
  };
  beatmaps?: ApiBeatmap[];
}

export interface BeatmapsetSearchResponse {
  beatmapsets: ApiBeatmapset[];
  cursor_string: string | null;
  total: number;
}
