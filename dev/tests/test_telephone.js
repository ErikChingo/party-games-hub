function telephoneTurnInfo(playerCount, turnIndex) {
  const round = Math.floor(turnIndex / playerCount);
  const playerIndex = turnIndex % playerCount;
  const chainIndex = ((playerIndex - round) % playerCount + playerCount) % playerCount;
  const stepType = round === 0 ? "write" : round % 2 === 1 ? "draw" : "guess";
  return { round, playerIndex, chainIndex, stepType };
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  }
}

for (let N = 3; N <= 6; N++) {
  const totalTurns = N * N;
  // For each round, chainIndex assignment across players must be a bijection (permutation of 0..N-1).
  for (let round = 0; round < N; round++) {
    const seen = new Set();
    for (let p = 0; p < N; p++) {
      const turnIndex = round * N + p;
      const info = telephoneTurnInfo(N, turnIndex);
      assert(info.round === round, `round mismatch N=${N} turnIndex=${turnIndex}`);
      assert(info.playerIndex === p, `playerIndex mismatch N=${N} turnIndex=${turnIndex}`);
      assert(info.chainIndex >= 0 && info.chainIndex < N, `chainIndex out of range N=${N} turnIndex=${turnIndex}`);
      seen.add(info.chainIndex);
    }
    assert(seen.size === N, `round ${round} N=${N} is not a bijection over chains: ${[...seen]}`);
  }

  // For each chain, over all rounds, the set of players who touch it must be
  // exactly all N players (each exactly once) -- i.e. also a bijection.
  for (let chain = 0; chain < N; chain++) {
    const playersForChain = [];
    for (let turnIndex = 0; turnIndex < totalTurns; turnIndex++) {
      const info = telephoneTurnInfo(N, turnIndex);
      if (info.chainIndex === chain) playersForChain.push(info.playerIndex);
    }
    assert(playersForChain.length === N, `chain ${chain} N=${N} touched ${playersForChain.length} times, expected ${N}`);
    const uniq = new Set(playersForChain);
    assert(uniq.size === N, `chain ${chain} N=${N} not touched by all distinct players: ${playersForChain}`);
  }

  // Round 0 (write) must always be the chain's own author (chainIndex === playerIndex).
  for (let p = 0; p < N; p++) {
    const info = telephoneTurnInfo(N, p);
    assert(info.round === 0 && info.stepType === "write", `turn ${p} N=${N} should be a write step`);
    assert(info.chainIndex === p, `player ${p} N=${N} should author chain ${p} at round 0, got chain ${info.chainIndex}`);
  }

  // No player ever works on their own chain immediately after writing it (round 1).
  for (let p = 0; p < N; p++) {
    const info = telephoneTurnInfo(N, N + p); // round 1
    assert(info.chainIndex !== p, `player ${p} N=${N} sees their own chain again at round 1`);
  }

  // Step type alternation: write, draw, guess, draw, guess, ...
  for (let round = 0; round < N; round++) {
    const info = telephoneTurnInfo(N, round * N);
    const expected = round === 0 ? "write" : round % 2 === 1 ? "draw" : "guess";
    assert(info.stepType === expected, `round ${round} N=${N} expected stepType ${expected}, got ${info.stepType}`);
  }

  // Total turn count sanity: last turn index N*N-1 is the last round's last player.
  const last = telephoneTurnInfo(N, totalTurns - 1);
  assert(last.round === N - 1, `last turn N=${N} should be round ${N - 1}, got ${last.round}`);
}

if (failures === 0) {
  console.log("All telephoneTurnInfo invariants passed for N=3..6.");
} else {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
