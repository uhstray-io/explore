// Pin and archive (I1). The state lives in each map's own map.json as `library`, so it is shared through Git, travels
// with exports, and two people pinning different maps never conflict. Like positions, these saves record no event
// and so no version. Nothing is ever deleted.
class LibraryProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const flag = (value, name) => { if (typeof value !== 'boolean') throw new LibraryProblem(`Say whether the map is ${name}: true or false.`); return value; };
const libraryOf = map => ({ pinned: !!map.library?.pinned, archived: !!map.library?.archived, ...(map.library?.archivedAt ? { archivedAt: map.library.archivedAt } : {}) });

export const libraryActions = {
  pin: { target: 'map', apply: ({ map, input }) => {
    const pinned = flag(input.pinned, 'pinned');
    if (pinned === libraryOf(map).pinned) throw new LibraryProblem(pinned ? 'This map is already pinned.' : 'This map is not pinned.', 409);
    map.library = { ...libraryOf(map), pinned };
  } },
  archive: { target: 'map', apply: ({ map, input }) => {
    const archived = flag(input.archived, 'archived'), { archivedAt, ...rest } = libraryOf(map);
    if (archived === rest.archived) throw new LibraryProblem(archived ? 'This map is already archived.' : 'This map is not archived.', 409);
    map.library = { ...rest, archived, ...(archived ? { archivedAt: new Date().toISOString() } : {}) };
  } },
};
