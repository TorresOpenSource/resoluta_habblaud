// Links do YouTube aceitos pela música de fundo.
import { describe, expect, it } from 'vitest';
import { parseYouTube } from './youtube';

describe('parseYouTube', () => {
  it('reconhece os formatos de link', () => {
    expect(parseYouTube('https://www.youtube.com/watch?v=jfKfPfyJRdk')).toEqual({ video: 'jfKfPfyJRdk' });
    expect(parseYouTube('youtu.be/jfKfPfyJRdk?t=10')).toEqual({ video: 'jfKfPfyJRdk' });
    expect(parseYouTube('https://music.youtube.com/watch?v=jfKfPfyJRdk&list=PLabcdefghij12')).toEqual({ video: 'jfKfPfyJRdk', list: 'PLabcdefghij12' });
    expect(parseYouTube('https://www.youtube.com/playlist?list=PLabcdefghij12')).toEqual({ list: 'PLabcdefghij12' });
    expect(parseYouTube('https://www.youtube.com/embed/jfKfPfyJRdk')).toEqual({ video: 'jfKfPfyJRdk' });
  });

  it('recusa o que não é link do YouTube', () => {
    expect(parseYouTube('')).toBeNull();
    expect(parseYouTube('https://evil.com/watch?v=jfKfPfyJRdk')).toBeNull();
    expect(parseYouTube('https://www.youtube.com/watch?v=curto')).toBeNull();
    expect(parseYouTube('não é link')).toBeNull();
  });
});
