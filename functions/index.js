// functions/index.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const axios = require('axios');

setGlobalOptions({ region: 'us-central1' }); // Set default region for all functions

admin.initializeApp(); // Initialize Firebase Admin SDK
const db = admin.firestore(); // Get Firestore instance

// --- Configuration for The Odds API ---
// IMPORTANT: Set this secret using the Firebase CLI:
// firebase functions:secrets:set THE_ODDS_API_KEY="YOUR_ACTUAL_ODDS_API_KEY"
const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;

const ODDS_API_BASE_URL = 'https://api.the-odds-api.com/v4';
const NFL_SPORT_KEY = 'americanfootball_nfl';
const REGIONS = 'us'; // Only 'us' as per your requirement
const MARKETS = 'h2h'; // Head-to-head (Moneyline) only

// --- Helper Function: Get Current NFL Week Info ---
// This function consistently determines the current "week" and associated deadlines.
function getCurrentNFLWeekInfo() {
    const now = new Date();
    const currentDay = now.getDay(); // 0 for Sunday, 1 for Monday, ..., 6 for Saturday

    // Calculate the date of the upcoming Tuesday (for start of betting week)
    let tuesday = new Date(now);
    // Adjust to the next Tuesday 12:01 AM
    tuesday.setDate(now.getDate() + (2 + 7 - currentDay) % 7);
    tuesday.setHours(0, 1, 0, 0); // 12:01 AM

    // Define betting window end: Thursday 5:00 PM of the same week
    const thursday5PM = new Date(tuesday);
    thursday5PM.setDate(thursday5PM.getDate() + 2); // Thursday
    thursday5PM.setHours(17, 0, 0, 0); // 5:00 PM

    // Define picks reveal time: Friday 12:00 PM of the same week
    const fridayNoon = new Date(thursday5PM);
    fridayNoon.setDate(fridayNoon.getDate() + 1); // Friday
    fridayNoon.setHours(12, 0, 0, 0); // 12:00 PM

    // A simple week ID based on the Tuesday's date.
    // In a real production app, you might use an official NFL week number from a season schedule.
    const weekId = `week-${tuesday.getFullYear()}-${tuesday.getMonth() + 1}-${tuesday.getDate()}`;

    return {
        weekId: weekId,
        bettingWindowStart: tuesday.toISOString(),
        bettingWindowEnd: thursday5PM.toISOString(),
        picksRevealTime: fridayNoon.toISOString(),
        tieBreakerGameId: null // This will be populated after fetching actual games
    };
}

// --- HTTPS Callable Function: getNFLOdds ---
// This function is called by the frontend to initiate fetching current NFL odds.
// It also updates the 'nflWeeks' collection in Firestore.
// Using onCall for v2 callable functions.
exports.getNFLOdds = onCall({
    timeoutSeconds: 30,
    memory: '256MiB', // Or higher if needed
    minInstances: 1 // <--- Consider adding this if frontend feels slow
}, async (data) => {
    // ... function body ...exports.getNFLOdds = onCall(async (data) => { // `context` is available on the `data` object if needed: `data.auth`, etc.
    // Ensure API key is available
    if (!ODDS_API_KEY) {
        logger.error("Odds API Key not configured.");
        throw new HttpsError('internal', 'API key missing.');
    }

    // IMPORTANT: Replace "default-app-id" with your actual Firebase project ID
    const appId = data.appId || "idas-72b3f"; // <-- CHANGE THIS TO YOUR PROJECT ID

    const weekInfo = getCurrentNFLWeekInfo();
    const weekDocRef = db.collection(`artifacts/${appId}/nflWeeks`).doc(weekInfo.weekId);

    try {
        // Fetch upcoming NFL odds
        const oddsResponse = await axios.get(
            `${ODDS_API_BASE_URL}/sports/${NFL_SPORT_KEY}/odds`, {
                params: {
                    apiKey: ODDS_API_KEY,
                    regions: REGIONS,
                    markets: MARKETS,
                    oddsFormat: 'american'
                }
            }
        );

        const games = oddsResponse.data.map(event => {
            const moneylineOdds = {};
            if (event.bookmakers && event.bookmakers.length > 0) {
                const firstBookmaker = event.bookmakers[0];
                const h2hMarket = firstBookmaker.markets.find(m => m.key === 'h2h');
                if (h2hMarket) {
                    h2hMarket.outcomes.forEach(outcome => {
                        moneylineOdds[outcome.name] = outcome.price;
                    });
                }
            }

            return {
                id: event.id,
                homeTeam: event.home_team,
                awayTeam: event.away_team,
                commenceTime: event.commence_time,
                odds: { moneyline: moneylineOdds },
                score: { home: null, away: null },
                completed: false
            };
        });

        const sortedGames = [...games].sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
        // FIX: Ensure sortedGames is not empty before accessing its last element
        weekInfo.tieBreakerGameId = sortedGames.length > 0 ? sortedGames[sortedGames.length - 1].id : null;

        await weekDocRef.set({
            ...weekInfo,
            games: games,
            actualTieBreakerTotalPoints: null,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        logger.info(`Successfully fetched and updated NFL odds for ${weekInfo.weekId}.`);
        return { success: true, message: `NFL Week ${weekInfo.weekId} games updated.`, games: games };

    } catch (error) {
        logger.error("Error in getNFLOdds Cloud Function:", error.message, error.response?.data);
        throw new HttpsError('internal', 'Failed to fetch odds.', error.message);
    }
});

// --- Scheduled Function: syncNflDataAndSettle ---
// Using onSchedule for v2 scheduled functions.
exports.syncNflDataAndSettle = onSchedule({
  schedule: 'every 1 minute',
  timeoutSeconds: 300,
  memory: '512MiB',
  cpu: 1,
  minInstances: 1
}, async (event) => {
  // function body...
    // `event` parameter is available for scheduled functions (e.g., event.id, event.time)
    
    // IMPORTANT: Replace "default-app-id" with your actual Firebase project ID
    const appId = "idas-72b3f"; // <-- CHANGE THIS TO YOUR PROJECT ID

    if (!ODDS_API_KEY) {
        logger.error("Odds API Key not configured for scheduled function.");
        return null; // Essential for scheduled functions to indicate completion/failure
    }

    const weekInfo = getCurrentNFLWeekInfo();
    const weekDocRef = db.collection(`artifacts/${appId}/nflWeeks`).doc(weekInfo.weekId);

    try {
        const weekDocSnap = await weekDocRef.get(); // <-- FIXED
        if (!weekDocSnap.exists) {
            logger.info(`No week data found for ${weekInfo.weekId}. Skipping sync/settle for now. Frontend should call getNFLOdds first.`);
            return null;
        }
        let currentWeekFirestoreData = weekDocSnap.data();
        let currentWeekGames = currentWeekFirestoreData.games || [];
        let actualTieBreakerTotalPoints = currentWeekFirestoreData.actualTieBreakerTotalPoints || null;
        let currentWeekTieBreakerGameId = currentWeekFirestoreData.tieBreakerGameId;

        const [oddsResponse, scoresResponse] = await Promise.all([
            axios.get(`${ODDS_API_BASE_URL}/sports/${NFL_SPORT_KEY}/odds`, {
                params: { apiKey: ODDS_API_KEY, regions: REGIONS, markets: MARKETS, oddsFormat: 'american' }
            }),
            axios.get(`${ODDS_API_BASE_URL}/sports/${NFL_SPORT_KEY}/scores`, {
                params: { apiKey: ODDS_API_KEY, daysFrom: 3 }
            })
        ]);

        const apiOddsData = oddsResponse.data;
        const apiScoresData = scoresResponse.data;

        const updatedWeekGames = currentWeekGames.map(game => {
            const liveScoreData = apiScoresData.find(s => s.id === game.id);
            const liveOddsData = apiOddsData.find(o => o.id === game.id);

            if (liveScoreData && liveScoreData.completed) {
                const homeScore = parseInt(liveScoreData.scores.find(s => s.name === game.homeTeam)?.score || 0);
                const awayScore = parseInt(liveScoreData.scores.find(s => s.name === game.awayTeam)?.score || 0);
                game.score = { home: homeScore, away: awayScore };
                game.completed = true;

                if (game.id === currentWeekTieBreakerGameId && actualTieBreakerTotalPoints === null) {
                    actualTieBreakerTotalPoints = homeScore + awayScore;
                }
            } else if (liveScoreData && liveScoreData.scores) {
                const homeScore = parseInt(liveScoreData.scores.find(s => s.name === game.homeTeam)?.score || 0);
                const awayScore = parseInt(liveScoreData.scores.find(s => s.name === game.awayTeam)?.score || 0);
                game.score = { home: homeScore, away: awayScore };
                game.completed = false;
            }

            if (liveOddsData) {
                const h2hMarket = liveOddsData.bookmakers[0]?.markets.find(m => m.key === 'h2h');
                if (h2hMarket) {
                    game.odds.moneyline = h2hMarket.outcomes.reduce((acc, outcome) => ({ ...acc, [outcome.name]: outcome.price }), {});
                }
            }
            return game;
        });

        apiOddsData.forEach(apiGame => {
            if (!updatedWeekGames.some(g => g.id === apiGame.id)) {
                updatedWeekGames.push({
                    id: apiGame.id,
                    homeTeam: apiGame.home_team,
                    awayTeam: apiGame.away_team,
                    commenceTime: apiGame.commence_time,
                    odds: apiGame.bookmakers[0]?.markets.find(m => m.key === 'h2h')?.outcomes.reduce(
                        (acc, outcome) => ({ ...acc, [outcome.name]: outcome.price }), {}
                    ) || {},
                    score: { home: null, away: null },
                    completed: false
                });
            }
        });

        await weekDocRef.update({
            ...weekInfo,
            games: updatedWeekGames,
            actualTieBreakerTotalPoints: actualTieBreakerTotalPoints,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
        logger.info(`NFL Week data for ${weekInfo.weekId} updated from API.`);

        const usersSnapshot = await db.collection(`artifacts/${appId}/users`).get();
        const payoutMultiplier = { 25: 0.1, 50: 0.12, 100: 0.15 };
        const userProfileUpdatesBatch = db.batch();
        const userPredictionUpdatesBatch = db.batch();

        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const userProfileRef = db.collection(`artifacts/${appId}/users/${userId}/profile`).doc('data');
            const userPredictionsRef = db.collection(`artifacts/${appId}/users/${userId}/predictions`).doc(weekInfo.weekId);
            const userPredictionsSnap = await userPredictionsRef.get();

            if (userPredictionsSnap.exists && !userPredictionsSnap.data().isSettled) {
                const predictionData = userPredictionsSnap.data();
                let totalCorrectPicks = 0;
                let totalWinnerBucksWonForThisEntry = 0;
                const updatedPicks = { ...predictionData.picks };
                let allGamesInThisSubmissionCompleted = true;

                for (const gameId in updatedPicks) {
                    const userPick = updatedPicks[gameId];
                    const gameFromFirestore = updatedWeekGames.find(g => g.id === gameId);

                    if (gameFromFirestore && gameFromFirestore.completed) {
                        if (userPick.outcome === 'pending') {
                            const homeScore = parseInt(gameFromFirestore.score.home);
                            const awayScore = parseInt(gameFromFirestore.score.away);

                            let winner = null;
                            if (homeScore > awayScore) winner = gameFromFirestore.homeTeam;
                            else if (awayScore > homeScore) winner = gameFromFirestore.awayTeam;

                            updatedPicks[gameId].outcome =
                                winner && userPick.pick === winner ? 'win' :
                                winner ? 'loss' : 'pending';

                            updatedPicks[gameId].winnings =
                                updatedPicks[gameId].outcome === 'win' ? userPick.tier * payoutMultiplier[userPick.tier] : 0;

                            if (updatedPicks[gameId].outcome === 'win') {
                                totalCorrectPicks++;
                                totalWinnerBucksWonForThisEntry += updatedPicks[gameId].winnings;
                            }
                        } else if (userPick.outcome === 'win') {
                            totalCorrectPicks++;
                            totalWinnerBucksWonForThisEntry += userPick.winnings;
                        }
                    } else {
                        allGamesInThisSubmissionCompleted = false;
                    }
                }

                const predictionUpdates = {
                    picks: updatedPicks,
                    totalCorrectPicks: totalCorrectPicks,
                    totalWinnerBucksWon: totalWinnerBucksWonForThisEntry,
                    isSettled: allGamesInThisSubmissionCompleted
                };
                userPredictionUpdatesBatch.update(userPredictionsRef, predictionUpdates);

                if (allGamesInThisSubmissionCompleted && totalWinnerBucksWonForThisEntry > (predictionData.totalWinnerBucksWon || 0)) {
                    const netWinnings = totalWinnerBucksWonForThisEntry - (predictionData.totalWinnerBucksWon || 0);
                    userProfileUpdatesBatch.update(userProfileRef, {
                        winnerBucks: admin.firestore.FieldValue.increment(netWinnings)
                    });
                }
            }
        }

        await userPredictionUpdatesBatch.commit();
        await userProfileUpdatesBatch.commit();
        logger.info(`User predictions for ${weekInfo.weekId} processed and settled.`);

        const updatedWeekData = (await weekDocRef.get()).data();
        const allGamesInWeekCompleted = updatedWeekData.games.every(game => game.completed);

        if (allGamesInWeekCompleted && updatedWeekData.actualTieBreakerTotalPoints !== null) {
            const leaderboardEntries = [];
            const allUserPicksSnap = await db.collection(`artifacts/${appId}/users`).get();

            for (const userDoc of allUserPicksSnap.docs) {
                const userId = userDoc.id;
                const profileData = (userDoc.data().profile?.data || {});
                const predictionsData = userDoc.data().predictions?.[weekInfo.weekId] || null;

                if (predictionsData && predictionsData.isSettled) {
                    leaderboardEntries.push({
                        id: userId,
                        username: profileData.username || `User_${userId.substring(0, 4)}`,
                        totalCorrectPicks: predictionsData.totalCorrectPicks,
                        totalWinnerBucksWon: predictionsData.totalWinnerBucksWon,
                        tieBreakerPoints: predictionsData.tieBreakerPoints
                    });
                }
            }

            leaderboardEntries.sort((a, b) => {
                if (b.totalCorrectPicks !== a.totalCorrectPicks) return b.totalCorrectPicks - a.totalCorrectPicks;
                if (b.totalWinnerBucksWon !== a.totalWinnerBucksWon) return b.totalWinnerBucksWon - a.totalWinnerBucksWon;

                const actualTotal = updatedWeekData.actualTieBreakerTotalPoints;
                const diffA = Math.abs(a.tieBreakerPoints - actualTotal);
                const diffB = Math.abs(b.tieBreakerPoints - actualTotal);
                return diffA - diffB;
            });

            await db.collection(`artifacts/${appId}/leaderboards`).doc(weekInfo.weekId).set({
                weekId: weekInfo.weekId,
                entries: leaderboardEntries,
                actualTieBreakerTotalPoints: actualTieBreakerTotalPoints,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
            logger.info(`Leaderboard for ${weekInfo.weekId} updated and tie-breaker applied.`);
        }

    } catch (error) {
        logger.error("Error in syncNflDataAndSettle scheduled function:", error.message);
        if (error.response) {
            logger.error("API Response Data:", error.response.data);
            logger.error("API Response Status:", error.response.status);
        }
    }
    return null;
});
