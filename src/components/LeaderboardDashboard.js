// src/components/LeaderboardDashboard.js
import React, { useState, useEffect } from 'react';
import { Users, Loader2 } from 'lucide-react';
import { useFirebase, useUser } from '../contexts';
import { doc, onSnapshot, collection, query } from 'firebase/firestore'; // Removed updateDoc as settlement is in functions

const LeaderboardDashboard = () => {
  const { db, userId } = useFirebase();
  const [leaderboard, setLeaderboard] = useState([]);
  const [myPicks, setMyPicks] = useState(null);
  const [currentWeekData, setCurrentWeekData] = useState(null); // Fetched from Firestore
  const [showOtherPicks, setShowOtherPicks] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

  // --- Helper to get current NFL Week ID consistently ---
  const getCurrentNFLWeekInfo = () => {
    const now = new Date();
    const currentDay = now.getDay();
    let tuesday = new Date(now);
    tuesday.setDate(now.getDate() + (2 + 7 - currentDay) % 7);
    tuesday.setHours(0, 1, 0, 0);
    return {
        weekId: `week-${tuesday.getFullYear()}-${tuesday.getMonth() + 1}-${tuesday.getDate()}`
    };
  };

  // --- Fetch NFL Week Data from Firestore ---
  useEffect(() => {
    if (!db) return;

    const currentWeekInfo = getCurrentNFLWeekInfo();
    const weekDocRef = doc(db, `artifacts/${appId}/nflWeeks`, currentWeekInfo.weekId);

    const unsubscribe = onSnapshot(weekDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setCurrentWeekData(data);
        setIsLoading(false);
        // Determine pick visibility based on live data
        setShowOtherPicks(new Date() > new Date(data.picksRevealTime));
      } else {
        console.log('Firestore: NFL week data not yet available for dashboard.');
        setCurrentWeekData(null);
        setIsLoading(false);
        setShowOtherPicks(false); // No data, so no picks to show
      }
    }, (error) => {
      console.error("Firestore: Error listening to NFL week data for dashboard:", error);
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, [db, appId]);

  // --- Fetch My Picks for the current week from Firestore ---
  useEffect(() => {
    if (!db || !userId || !currentWeekData) return; // Wait for currentWeekData to load
    const myPicksDocRef = doc(db, `artifacts/${appId}/users/${userId}/predictions`, currentWeekData.weekId);
    const unsubscribeMyPicks = onSnapshot(myPicksDocRef, (docSnap) => {
      if (docSnap.exists()) {
        setMyPicks(docSnap.data());
      } else {
        setMyPicks(null);
      }
    });
    return () => unsubscribeMyPicks();
  }, [db, userId, appId, currentWeekData]);


  // --- Fetch Leaderboard Data from Firestore ---
  useEffect(() => {
    if (!db || !currentWeekData) return; // Wait for currentWeekData to ensure weekId is ready

    const leaderboardDocRef = doc(db, `artifacts/${appId}/leaderboards`, currentWeekData.weekId);
    const unsubscribeLeaderboard = onSnapshot(leaderboardDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        // Leaderboard data entries are already sorted by the Cloud Function, but ensure consistent structure
        setLeaderboard(data.entries || []);
      } else {
        setLeaderboard([]); // No leaderboard data yet for this week
      }
    });
    return () => unsubscribeLeaderboard();
  }, [db, appId, currentWeekData]);


  // --- Helper to calculate user wins based on actual game outcomes (from currentWeekData) ---
  const calculateUserWins = (userPicks, weekGames) => {
    if (!userPicks || !weekGames) return 'N/A';
    let correctPicks = 0;
    for (const gameId in userPicks) {
      const pick = userPicks[gameId].pick;
      const gameActual = weekGames.find(g => g.id === gameId); // Get game data from weekGames

      if (gameActual && gameActual.completed && gameActual.score.home !== null && gameActual.score.away !== null) {
        const homeScore = gameActual.score.home;
        const awayScore = gameActual.score.away;
        let winner = null;
        if (homeScore > awayScore) winner = gameActual.homeTeam;
        else if (awayScore > homeScore) winner = gameActual.awayTeam;

        if (winner && pick === winner) {
          correctPicks++;
        }
      }
    }
    return correctPicks;
  };


  // --- Loading State and UI ---
  if (isLoading || !currentWeekData) {
    return (
      <section className="w-full bg-gray-700 p-6 rounded-xl shadow-md mb-8 flex flex-col items-center">
        <Loader2 className="animate-spin h-8 w-8 text-blue-500" />
        <p className="text-gray-300 mt-2">Loading leaderboard data...</p>
      </section>
    );
  }

  // Filter out current user from main leaderboard for dedicated "My Picks" section display
  const filteredLeaderboard = leaderboard.filter(entry => entry.id !== userId);
  // Find current user's entry in leaderboard for consistent data, or use myPicks
  const currentUserLeaderboardEntry = leaderboard.find(entry => entry.id === userId);


  return (
    <section className="w-full bg-gray-700 p-6 rounded-xl shadow-md mb-8 flex flex-col items-center">
      <h3 className="text-xl font-semibold text-white mb-4 flex items-center">
        <Users className="mr-2" /> Leaderboard & My Picks
      </h3>

      {/* My Picks Dashboard */}
      <div className="w-full mb-8">
        <h4 className="text-xl font-semibold text-blue-300 mb-4">
          My Picks - Week {currentWeekData.weekId.split('-').pop()}
        </h4>
        {myPicks ? (
          <div className="bg-gray-900 p-4 rounded-lg shadow-inner">
            {Object.values(myPicks.picks).map((pickData) => {
              const game = currentWeekData.games.find(g => g.id === pickData.gameId);
              if (!game) return null;

              // Determine outcome display based on actual game status from currentWeekData.games
              let outcomeDisplay = 'Pending';
              let outcomeColor = 'text-yellow-400';
              if (game.completed) {
                const homeScore = game.score.home;
                const awayScore = game.score.away;
                let actualWinner = null;
                if (homeScore > awayScore) actualWinner = game.homeTeam;
                else if (awayScore > homeScore) actualWinner = game.awayTeam;

                if (actualWinner && pickData.pick === actualWinner) {
                  outcomeDisplay = 'WIN';
                  outcomeColor = 'text-green-400';
                } else if (actualWinner) {
                  outcomeDisplay = 'LOSS';
                  outcomeColor = 'text-red-400';
                }
              }

              return (
                <div key={game.id} className="flex justify-between items-center py-2 border-b border-gray-700 last:border-b-0">
                  <span className="text-gray-200">
                    {game.homeTeam} vs {game.awayTeam}
                  </span>
                  <span className="text-blue-300 font-semibold">
                    {pickData.pick} ({pickData.tier} Pts)
                  </span>
                  <span className={`font-bold ${outcomeColor}`}>
                    {outcomeDisplay}
                  </span>
                </div>
              );
            })}
            <p className="text-sm text-gray-300 mt-4">
              My Tie-breaker guess: {myPicks.tieBreakerPoints}
            </p>
            {currentWeekData.actualTieBreakerTotalPoints && (
              <p className="text-sm text-gray-300">
                Actual Tie-breaker total: {currentWeekData.actualTieBreakerTotalPoints}
              </p>
            )}
            {myPicks.totalCorrectPicks > 0 && (
                <p className="text-sm text-green-400 font-semibold mt-2">
                    Total Correct Picks: {myPicks.totalCorrectPicks}
                </p>
            )}
             {myPicks.totalWinnerBucksWon > 0 && (
                <p className="text-sm text-green-400 font-semibold">
                    Total Winner Bucks Won (this entry): ${myPicks.totalWinnerBucksWon.toFixed(2)}
                </p>
            )}
          </div>
        ) : (
          <p className="text-gray-300 text-center">
            You haven't submitted picks for this week yet.
          </p>
        )}
      </div>

      {/* Global Leaderboard Section */}
      <div className="w-full">
        <h4 className="text-xl font-semibold text-blue-300 mb-4">Global Leaderboard</h4>
        {!showOtherPicks && (
          <p className="text-yellow-400 text-center mb-4">
            Other users' picks will be revealed after the betting deadline:{' '}
            {new Date(currentWeekData.picksRevealTime).toLocaleString()}
          </p>
        )}
        <div className="bg-gray-900 p-4 rounded-lg shadow-inner">
          <div className="grid grid-cols-3 md:grid-cols-4 font-bold text-blue-400 pb-2 border-b border-gray-600">
            <span>Rank</span>
            <span>User</span>
            <span className="text-center">Wins (Current)</span>
            <span className="text-right">Total $ Won</span>
          </div>
          {filteredLeaderboard.length === 0 && !currentUserLeaderboardEntry ? (
             <p className="text-gray-400 text-center py-4">No leaderboard data yet or you are the only user.</p>
          ) : (
            // Display current user at top if present, then the rest of the leaderboard
            [...(currentUserLeaderboardEntry ? [{ ...currentUserLeaderboardEntry, isSelf: true }] : []), ...filteredLeaderboard]
            .sort((a, b) => {
              // Primary sort: total correct picks
              if (b.totalCorrectPicks !== a.totalCorrectPicks) return b.totalCorrectPicks - a.totalCorrectPicks;
              // Secondary sort: total Winner Bucks won for the week
              if (b.totalWinnerBucksWon !== a.totalWinnerBucksWon) return b.totalWinnerBucksWon - a.totalWinnerBucksWon;
              // Tertiary sort: tie-breaker (only if picks are revealed and actual score is available)
              if (showOtherPicks && currentWeekData.actualTieBreakerTotalPoints !== null) {
                const actualTotal = currentWeekData.actualTieBreakerTotalPoints;
                const diffA = Math.abs(a.tieBreakerPoints - actualTotal);
                const diffB = Math.abs(b.tieBreakerPoints - actualTotal);
                return diffA - diffB;
              }
              return 0; // Maintain original order if no tie-breaker criteria apply
            })
            .map((userEntry, index) => {
              const isCurrentUser = userEntry.id === userId;
              // For other users before picks reveal, display N/A for sensitive data
              const currentWeekWins = showOtherPicks ? calculateUserWins(userEntry.currentWeekPicks, currentWeekData.games) : 'N/A';
              const totalDollarsWonDisplay = showOtherPicks ? `$${userEntry.totalWinnerBucksWon.toFixed(2)}` : 'N/A';

              return (
                <div
                  key={userEntry.id}
                  className={`grid grid-cols-3 md:grid-cols-4 items-center py-2 border-b border-gray-700 last:border-b-0 ${isCurrentUser ? 'bg-blue-800 bg-opacity-30 rounded-md' : ''}`}
                >
                  <span>{index + 1}</span>
                  <span className={`${isCurrentUser ? 'text-blue-300 font-bold' : 'text-gray-200'}`}>
                    {userEntry.username} {isCurrentUser ? '(You)' : ''}
                  </span>
                  <span className="text-center">{currentWeekWins}</span>
                  <span className="text-right text-green-400 font-semibold">
                    {totalDollarsWonDisplay}
                  </span>
                  {showOtherPicks && userEntry.currentWeekPicks && (
                    <div className="col-span-3 md:col-span-4 mt-2 p-2 bg-gray-800 rounded-md text-sm text-gray-300">
                      <p className="font-semibold mb-1">Picks:</p>
                      {Object.values(userEntry.currentWeekPicks).map(pickData => {
                        const game = currentWeekData.games.find(g => g.id === pickData.gameId);
                        if (!game) return null;
                        return (
                          <p key={`${userEntry.id}-${game.id}`}>
                            {game.homeTeam} vs {game.awayTeam}: {pickData.pick}
                          </p>
                        );
                      })}
                      <p className="font-semibold mt-1">Tie-breaker: {userEntry.tieBreakerPoints}</p>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
};

export default LeaderboardDashboard;
