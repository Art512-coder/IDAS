// src/components/NFLGamePicks.js
import React, { useState, useEffect } from 'react';
import { Target, Calendar, Loader2 } from 'lucide-react'; // Target is used for the icon
import { useFirebase, useUser } from '../contexts'; // Contexts are imported from parent directory
import { doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { toast } from 'react-toastify';

// Import Firebase Functions client SDK for callable functions
import { getFunctions, httpsCallable } from 'firebase/functions';

const NFLGamePicks = () => {
  const { userData, setUserData, userId } = useUser();
  const { db, firebaseApp } = useFirebase(); // Get firebaseApp from context to initialize functions
  const [weeklyGames, setWeeklyGames] = useState(null); // Weekly games data fetched from Firestore
  const [userPicks, setUserPicks] = useState({}); // Stores user's selected picks for the current week
  const [selectedTier, setSelectedTier] = useState(25); // Default betting tier
  const [tieBreakerPoints, setTieBreakerPoints] = useState(''); // User's tie-breaker guess
  const [message, setMessage] = useState(''); // Message for modal notifications
  const [showModal, setShowModal] = useState(false); // Controls visibility of notification modal
  const [userWeeklyEntriesCount, setUserWeeklyEntriesCount] = useState(0); // Count of user's entries this week
  const [isLoading, setIsLoading] = useState(true); // Loading state for component

  const bettingTiers = [25, 50, 100]; // Available betting tiers
  const maxEntriesPerWeek = 3; // Maximum number of entries per user per week
  const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Firebase App ID

  // Initialize Firebase Functions client and callable function for getNFLOdds
  const functions = firebaseApp ? getFunctions(firebaseApp) : null;
  const getNFLOddsCallable = functions ? httpsCallable(functions, 'getNFLOdds') : null;

  // --- Helper to get current NFL Week ID consistently ---
  // This ensures the week ID matches how it's calculated in Cloud Functions
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

  // --- Effect: Fetch NFL Week Data from Firestore (updated by Cloud Function) ---
  // This listens for updates to the current week's NFL data in Firestore.
  // If no data exists, it triggers a Cloud Function to fetch it from The Odds API.
  useEffect(() => {
    if (!db || !getNFLOddsCallable) { // Ensure db and callable function are ready
      setIsLoading(false); // Stop loading if prerequisites aren't met
      return;
    }

    const currentWeekInfo = getCurrentNFLWeekInfo(); // Get consistent week info
    const weekDocRef = doc(db, `artifacts/${appId}/nflWeeks`, currentWeekInfo.weekId); // Reference to the week's document

    const unsubscribe = onSnapshot(weekDocRef, async (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setWeeklyGames(data); // Set the weekly games data from Firestore
        console.log('Firestore: Weekly games data updated:', data);
        setIsLoading(false); // Data loaded, stop loading indicator
      } else {
        // If week data doesn't exist in Firestore, trigger the Cloud Function
        console.log('Firestore: Weekly games data not found, attempting to fetch from API via Cloud Function...');
        try {
          // Call the getNFLOdds Cloud Function, passing the appId
          const result = await getNFLOddsCallable({ appId: appId });
          if (result.data.success) {
            console.log('Cloud Function getNFLOdds successfully triggered and data populated.');
            // The onSnapshot listener will pick up the data once the function writes it
          } else {
            setMessage('Failed to get NFL game data. Please try again later.');
            setShowModal(true);
            setIsLoading(false);
          }
        } catch (error) {
          console.error('Error calling getNFLOdds Cloud Function:', error);
          setMessage('Failed to fetch NFL game data. Ensure Cloud Functions are deployed and API key is set.');
          setShowModal(true);
          setIsLoading(false);
        }
      }
    }, (error) => {
      console.error("Firestore: Error listening to NFL week data:", error);
      setMessage('Failed to load NFL games due to a database error.');
      setShowModal(true);
      setIsLoading(false);
    });

    return () => unsubscribe(); // Clean up the Firestore listener
  }, [db, appId, firebaseApp, getNFLOddsCallable]); // Dependencies: db, appId, firebaseApp, callable function

  // --- Effect: Listen to User Picks and Entries from Firestore ---
  useEffect(() => {
    if (!db || !userId || !weeklyGames) return; // Wait for db, userId, and weeklyGames to be loaded

    const userPicksDocRef = doc(db, `artifacts/${appId}/users/${userId}/predictions`, weeklyGames.weekId);
    const userProfileRef = doc(db, `artifacts/${appId}/users/${userId}/profile`, 'data');

    // Listen to user's current week predictions
    const unsubscribePicks = onSnapshot(userPicksDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setUserPicks(data.picks || {}); // Set user's picks
        setTieBreakerPoints(data.tieBreakerPoints || ''); // Set tie-breaker guess
      } else {
        setUserPicks({}); // Reset if no picks found
        setTieBreakerPoints('');
      }
    });

    // Listen to user's profile to get weekly entries count
    const unsubscribeProfile = onSnapshot(userProfileRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setUserData(data); // Keep user data in context updated
        setUserWeeklyEntriesCount(data.weeklyEntries?.[weeklyGames.weekId] || 0); // Update entries count
      }
    });

    return () => {
      unsubscribePicks(); // Clean up pick listener
      unsubscribeProfile(); // Clean up profile listener
    };
  }, [db, userId, weeklyGames, appId, setUserData]); // Dependencies: db, userId, weeklyGames, appId, setUserData

  // --- Betting Window & Picks Locked Status ---
  // Determine if betting is open based on current time and week's deadlines
  const bettingOpen = weeklyGames && new Date() >= new Date(weeklyGames.bettingWindowStart) && new Date() <= new Date(weeklyGames.bettingWindowEnd);
  // Determine if picks are locked (after betting deadline)
  const picksLocked = weeklyGames && new Date() > new Date(weeklyGames.bettingWindowEnd);

  // --- Handlers for User Interactions ---
  // Handles selecting a team for a game
  const handlePickChange = (gameId, teamName) => {
    // Prevent changes if betting is closed, picks are locked, or entry cap is reached
    if (!bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek) return; 

    setUserPicks(prevPicks => ({
      ...prevPicks,
      [gameId]: {
        ...prevPicks[gameId],
        pick: teamName,
        tier: selectedTier, // Assign current selected tier to this pick
        gameId: gameId,
        // 'locked' status is handled by backend submission and settlement logic
      },
    }));
  };

  // Handles changing the betting tier (25/50/100 Points)
  const handleTierChange = (tier) => {
    // Prevent changes if betting is closed or entry cap is reached
    if (!bettingOpen || userWeeklyEntriesCount >= maxEntriesPerWeek) return; 

    setSelectedTier(tier); // Update selected tier
    // Apply the new tier to all existing picks in the current form state
    setUserPicks(prevPicks => {
      const updatedPicks = {};
      for (const gameId in prevPicks) {
        updatedPicks[gameId] = {
          ...prevPicks[gameId],
          tier: tier,
        };
      }
      return updatedPicks;
    });
  };

  // Handles input for tie-breaker points
  const handleTieBreakerChange = (e) => {
    // Prevent changes if betting is closed, picks are locked, or entry cap is reached
    if (!bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek) return; 

    const value = e.target.value;
    // Allow empty string (initial state) or valid numbers between 0 and 200 (a reasonable NFL score range)
    if (value === '' || (/^\d+$/.test(value) && parseInt(value) >= 0 && parseInt(value) <= 200)) {
      setTieBreakerPoints(value);
    }
  };

  // --- Handles Submission of Weekly Picks ---
  const handleSubmitPicks = async () => {
    // Basic validation: ensure user and database are ready
    if (!userId || !db || !userData) { 
      setMessage('User not authenticated or data not loaded. Please try again.');
      setShowModal(true);
      return;
    }

    // Validation: Check if betting window is open
    if (!bettingOpen) {
      setMessage('Betting is currently closed. Please check the betting window.');
      setShowModal(true);
      return;
    }

    // Validation: Check against weekly entry cap
    if (userWeeklyEntriesCount >= maxEntriesPerWeek) {
      setMessage(`You have reached the maximum of ${maxEntriesPerWeek} entries for this week.`);
      setShowModal(true);
      return;
    }

    // Validation: Ensure picks have been made for ALL games
    if (!weeklyGames || Object.keys(userPicks).length !== weeklyGames.games.length) {
      setMessage('You must make a pick for ALL games this week.');
      setShowModal(true);
      return;
    }

    // Validation: Check for tie-breaker game existence and valid input
    const tieBreakerGame = weeklyGames.games.find(game => game.id === weeklyGames.tieBreakerGameId);
    if (!tieBreakerGame) {
      setMessage('Tie-breaker game not found for this week. Cannot submit picks.');
      setShowModal(true);
      return;
    }
    if (tieBreakerPoints === '' || isNaN(parseInt(tieBreakerPoints))) {
      setMessage(`Please enter a valid total score for the tie-breaker game (${tieBreakerGame.homeTeam} vs ${tieBreakerGame.awayTeam}).`);
      setShowModal(true);
      return;
    }

    // Prepare picks data structure for Firestore
    const picksToSubmit = {};
    for (const game of weeklyGames.games) {
      if (!userPicks[game.id] || !userPicks[game.id].pick) {
        setMessage(`Missing pick for ${game.homeTeam} vs ${game.awayTeam}.`);
        setShowModal(true);
        return;
      }
      picksToSubmit[game.id] = {
        pick: userPicks[game.id].pick,
        tier: selectedTier, // All picks in this submission use the selected tier
        gameId: game.id,
        outcome: 'pending', // Initial outcome status
        winnings: 0, // Initial winnings
      };
    }

    // Firestore references for user's prediction and profile documents
    const userPicksDocRef = doc(db, `artifacts/${appId}/users/${userId}/predictions`, weeklyGames.weekId);
    const userProfileRef = doc(db, `artifacts/${appId}/users/${userId}/profile`, 'data');

    try {
      const costPerEntry = selectedTier;
      // Validation: Check if user has enough Predictor Points
      if ((userData.predictorPoints || 0) < costPerEntry) {
        setMessage(`Not enough Predictor Points! You need ${costPerEntry} to submit this entry.`);
        setShowModal(true);
        return;
      }

      // Atomic update for user profile and setting the new predictions document
      await updateDoc(userProfileRef, {
        predictorPoints: (userData.predictorPoints || 0) - costPerEntry, // Deduct points
        // Increment weekly entries count
        [`weeklyEntries.${weeklyGames.weekId}`]: (userData.weeklyEntries?.[weeklyGames.weekId] || 0) + 1,
      });

      // Submit user's picks to Firestore
      await setDoc(userPicksDocRef, {
        userId: userId,
        weekId: weeklyGames.weekId,
        picks: picksToSubmit,
        tieBreakerPoints: parseInt(tieBreakerPoints), // Store as number
        submittedAt: new Date().toISOString(), // Timestamp of submission
        tier: selectedTier, // Store the tier of this overall entry
        isSettled: false, // Initial state, to be updated by backend settlement function
        totalCorrectPicks: 0, // Initial, to be updated by backend
        totalWinnerBucksWon: 0, // Initial, to be updated by backend
      });

      // Optimistically update local user data state (for immediate UI feedback)
      setUserData(prevData => ({
        ...prevData,
        predictorPoints: (prevData.predictorPoints || 0) - costPerEntry,
        weeklyEntries: {
          ...prevData.weeklyEntries,
          [weeklyGames.weekId]: (prevData.weeklyEntries?.[weeklyGames.weekId] || 0) + 1,
        },
      }));

      toast.success('Your NFL picks have been submitted successfully!'); // Show success toast
      setShowModal(true); // Show notification modal
    } catch (error) {
      console.error('Error submitting picks:', error);
      setMessage('Failed to submit picks. Please try again. ' + error.message);
      setShowModal(true); // Show error modal
    }
  };

  // --- Loading State UI ---
  if (isLoading || !weeklyGames) {
    return (
      <section className="w-full bg-gray-700 p-6 rounded-xl shadow-md mb-8 flex flex-col items-center">
        <Loader2 className="animate-spin h-8 w-8 text-blue-500" />
        <p className="text-gray-300 mt-2">Loading NFL games...</p>
      </section>
    );
  }

  // --- Main Component Render ---
  return (
    <section className="w-full bg-gray-700 p-6 rounded-xl shadow-md mb-8 flex flex-col items-center">
      <h3 className="text-xl font-semibold text-white mb-4 flex items-center">
        <Goal className="mr-2" /> NFL Week {weeklyGames.weekId.split('-').pop()} Picks
      </h3>
      {/* Display Betting Window Information */}
      <p className="text-gray-400 text-center mb-4">
        Betting Window: {new Date(weeklyGames.bettingWindowStart).toLocaleString()} -{' '}
        {new Date(weeklyGames.bettingWindowEnd).toLocaleString()}
      </p>
      {/* Display messages if betting is closed or cap reached */}
      {!bettingOpen && (
        <p className="text-red-400 font-bold mb-4">Betting is currently closed for this week.</p>
      )}
      {userWeeklyEntriesCount >= maxEntriesPerWeek && (
        <p className="text-yellow-400 font-bold mb-4">
          You have reached your limit of {maxEntriesPerWeek} entries this week.
        </p>
      )}

      {/* Betting Tiers Selection */}
      <div className="flex justify-center space-x-4 mb-6">
        <span className="text-gray-300 font-medium">Select Entry Tier:</span>
        {bettingTiers.map(tier => (
          <button
            key={tier}
            onClick={() => handleTierChange(tier)}
            className={`px-4 py-2 rounded-full font-semibold transition-colors ${
              selectedTier === tier ? 'bg-purple-600 text-white shadow-lg' : 'bg-gray-600 text-gray-300 hover:bg-purple-500'
            } ${!bettingOpen || userWeeklyEntriesCount >= maxEntriesPerWeek ? 'opacity-50 cursor-not-allowed' : ''}`}
            disabled={!bettingOpen || userWeeklyEntriesCount >= maxEntriesPerWeek}
          >
            {tier} Predictor Points
          </button>
        ))}
      </div>

      {/* NFL Game List for Picks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {weeklyGames.games.map((game) => {
          const gameTime = new Date(game.commenceTime).toLocaleString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          const isTieBreakerGame = game.id === weeklyGames.tieBreakerGameId;
          const isLive = game.score && (game.score.home !== null || game.score.away !== null); // Check if scores exist

          return (
            <div
              key={game.id}
              className={`bg-gray-900 p-4 rounded-lg shadow-lg flex flex-col ${picksLocked ? 'opacity-70' : ''}`}
            >
              <div className="flex justify-between items-center mb-1">
                <p className="text-sm text-gray-400">
                  NFL - {game.homeTeam} vs {game.awayTeam}
                </p>
                {/* Display Live/Final status if game has commenced */}
                {new Date(game.commenceTime) < new Date() && !game.completed && (
                  <span className="text-red-500 text-xs font-bold">LIVE</span>
                )}
                 {game.completed && (
                  <span className="text-green-500 text-xs font-bold">FINAL</span>
                )}
              </div>
              <p className="text-sm text-blue-300 flex items-center mb-3">
                <Calendar className="mr-1 h-3 w-3" /> {gameTime}
              </p>
              <div className="flex justify-around items-center mb-3">
                <div className="text-center">
                  <h4 className="text-lg font-bold text-white">{game.homeTeam}</h4>
                  <p className="text-sm text-green-400">
                    ({game.odds.moneyline[game.homeTeam] > 0 ? '+' : ''}
                    {game.odds.moneyline[game.homeTeam] || 'N/A'})
                  </p>
                  {isLive && (
                    <p className="text-sm text-yellow-400">
                      Score: {game.score.home || 0}
                    </p>
                  )}
                </div>
                <span className="text-gray-300 text-sm mx-2">VS</span>
                <div className="text-center">
                  <h4 className="text-lg font-bold text-white">{game.awayTeam}</h4>
                  <p className="text-sm text-green-400">
                    ({game.odds.moneyline[game.awayTeam] > 0 ? '+' : ''}
                    {game.odds.moneyline[game.awayTeam] || 'N/A'})
                  </p>
                  {isLive && (
                    <p className="text-sm text-yellow-400">
                      Score: {game.score.away || 0}
                    </p>
                  )}
                </div>
              </div>

              {/* Pick Buttons */}
              <div className="flex justify-center space-x-2 mt-2">
                <button
                  onClick={() => handlePickChange(game.id, game.homeTeam)}
                  className={`px-3 py-1 rounded-full text-sm font-semibold transition-colors ${
                    userPicks[game.id]?.pick === game.homeTeam ? 'bg-blue-500 text-white' : 'bg-gray-600 text-gray-300 hover:bg-blue-400'
                  } ${!bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek ? 'opacity-50 cursor-not-allowed' : ''}`}
                  disabled={!bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek}
                >
                  Pick {game.homeTeam}
                </button>
                <button
                  onClick={() => handlePickChange(game.id, game.awayTeam)}
                  className={`px-3 py-1 rounded-full text-sm font-semibold transition-colors ${
                    userPicks[game.id]?.pick === game.awayTeam ? 'bg-blue-500 text-white' : 'bg-gray-600 text-gray-300 hover:bg-blue-400'
                  } ${!bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek ? 'opacity-50 cursor-not-allowed' : ''}`}
                  disabled={!bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek}
                >
                  Pick {game.awayTeam}
                </button>
              </div>

              {/* Tie-breaker Input */}
              {isTieBreakerGame && (
                <div className="mt-4 text-center">
                  <p className="text-sm text-yellow-300 mb-2">Tie-breaker: Guess total points for this game</p>
                  <input
                    type="number"
                    value={tieBreakerPoints}
                    onChange={handleTieBreakerChange}
                    placeholder="Total Points"
                    className={`w-24 px-2 py-1 bg-gray-800 text-white text-center rounded-md border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      !bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                    disabled={!bettingOpen || picksLocked || userWeeklyEntriesCount >= maxEntriesPerWeek}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    (Closest guess wins in case of a tie in total correct picks)
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Submit Picks Button */}
      <button
        onClick={handleSubmitPicks}
        className={`mt-8 px-8 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-full text-xl transition-all duration-300 transform hover:scale-105 shadow-lg
          ${!bettingOpen || Object.keys(userPicks).length !== weeklyGames.games.length || tieBreakerPoints === '' || userWeeklyEntriesCount >= maxEntriesPerWeek ? 'opacity-50 cursor-not-allowed' : ''}`}
        disabled={!bettingOpen || Object.keys(userPicks).length !== weeklyGames.games.length || tieBreakerPoints === '' || userWeeklyEntriesCount >= maxEntriesPerWeek}
      >
        Submit Weekly Picks ({selectedTier} Points)
      </button>

      {/* Notification Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-6 rounded-lg shadow-xl border border-blue-500 text-center">
            <h4 className="text-xl font-bold text-white mb-4">Notification</h4>
            <p className="text-lg text-gray-300 mb-6">{message}</p>
            <button
              onClick={() => setShowModal(false)}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-full font-semibold transition-all duration-300"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default NFLGamePicks;
