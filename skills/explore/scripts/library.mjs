// Pin and archive (I1). The state lives in each map's own map.json as `library`, so it is shared through Git, travels
// with exports, and two people pinning different maps never conflict. Like positions, these saves record no event
// and so no version. Nothing is ever deleted.
class LibraryProblem extends Error { constructor(message) { super(message); this.status = 400; } }
const flag = (value, name) => { if (typeof value !== 'boolean') throw new LibraryProblem(`Say whether the map is ${name}: true or false.`); return value; };
const libraryOf = map => ({ pinned: !!map.library?.pinned, archived: !!map.library?.archived, ...(map.library?.archivedAt ? { archivedAt: map.library.archivedAt } : {}) });

export const libraryActions = {
  pin: { target: 'map', apply: ({ map, input }) => { map.library = { ...libraryOf(map), pinned: flag(input.pinned, 'pinned') }; } },
  archive: { target: 'map', apply: ({ map, input }) => {
    const archived = flag(input.archived, 'archived'), { archivedAt, ...rest } = libraryOf(map);
    map.library = { ...rest, archived, ...(archived ? { archivedAt: new Date().toISOString() } : {}) };
  } },
};
