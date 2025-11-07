<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ALCONCENT - 酔っ払い度チェック</title>
  
  <!-- Tailwind CSS (CDN) --><script src="https://cdn.tailwindcss.com"></script>
  
  <!-- Lucide Icons (CDN) --><script src="https://unpkg.com/lucide@latest"></script>
  
  <style>
    /* 3Dフリップアニメーション用のユーティリティ */
    .perspective-1000 { perspective: 1000px; }
    .transform-style-3d { transform-style: preserve-3d; }
    .backface-hidden { backface-visibility: hidden; }
    .rotate-y-180 { transform: rotateY(180deg); }
    /* ローディングスピナー */
    .loader {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #3498db;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    /* 酔っ払い度レベル表示 */
    .drunk-level-bar {
      display: flex;
      height: 20px;
      border-radius: 10px;
      overflow: hidden;
      background: #374151; /* bg-gray-700 */
    }
    .drunk-level-fill {
      transition: width 0.5s ease-in-out;
      background: linear-gradient(90deg, #34d399, #fde047, #f97316, #ef4444);
    }

    /* マッチ時のキラキラアニメーション */
    @keyframes pulse-ring {
      0% {
        transform: scale(0.3);
        opacity: 0.7;
      }
      100% {
        transform: scale(1.5);
        opacity: 0;
      }
    }

    .matched-pulse-effect::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 100%;
      height: 100%;
      background: radial-gradient(circle, rgba(255, 255, 0, 0.5) 0%, transparent 70%);
      border-radius: 50%;
      animation: pulse-ring 0.6s ease-out forwards;
      transform: translate(-50%, -50%); /* 中央に配置 */
      z-index: 10;
    }
    
    /* カードがマッチして消えるときのアニメーション */
    .fade-out-match {
      transition: opacity 0.5s ease-out, transform 0.5s ease-out;
      opacity: 0;
      transform: scale(0.8);
    }
  </style>
</head>
<body class="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white font-sans p-4">

  <!-- ゲームのUI全体がこの中に描画される --><div id="app-container" class="w-full max-w-2xl text-center">
    <!-- JavaScriptによって中身が生成されます --></div>

  <script>
    // --- 定数と設定 ---
    const allIconList = [
      'Heart', 'Star', 'Smile', 'Sun', 'Moon', 'Cloud', 'Anchor', 'Gift',
      'Coffee', 'Feather', 'Bell', 'Book', 'Camera', 'Flag', 'Globe', 'Key',
      'Headphones', 'Home', 'Image', 'Inbox', 'Layers', 'Map'
    ];
    // 酔っ払い度チェック用のレベル（固定）
    const GAME_LEVEL = { id: 3, name: "Hard", pairs: 8, cols: 4 }; // レベル3固定
    const BASELINE_STORAGE_KEY = 'alconcent-baseline';

    // --- ゲームの状態 ---
    let gameState = 'SELECT'; // 'SELECT', 'BASELINE', 'CHECK', 'LOADING', 'RESULT'
    let baselineResult = null; // { moves: 0, time: 0 }
    let currentResult = null;  // { moves: 0, time: 0 }
    let apiResponse = null;    // { drunk_level: 0, analysis: "" }

    // --- ゲームボードの状態 ---
    let cards = [];
    let flippedCards = [];
    let moves = 0;
    let isChecking = false;
    let justMatched = []; // [id, id]
    let animatingMatch = []; // マッチアニメーション中のカードID

    // --- タイマーの状態 ---
    let timerInterval = null;
    let startTime = 0;
    let elapsedTime = 0; // 秒

    // --- DOM要素 ---
    let appContainer;

    // --- ヘルパー関数 (シャッフル) ---
    function shuffleArray(array) {
      let currentIndex = array.length, randomIndex;
      while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [
          array[randomIndex], array[currentIndex]
        ];
      }
      return array;
    }

    // --- タイマー関数 ---
    function startTimer() {
      startTime = Date.now();
      timerInterval = setInterval(() => {
        elapsedTime = Math.floor((Date.now() - startTime) / 1000);
        const timerEl = document.getElementById('timer-display');
        if (timerEl) {
          timerEl.textContent = `${elapsedTime} 秒`;
        }
      }, 1000);
    }

    function stopTimer() {
      clearInterval(timerInterval);
      timerInterval = null;
      elapsedTime = Math.floor((Date.now() - startTime) / 1000);
    }

    // --- ゲームロジック ---
    const initializeGame = () => {
      const levelConfig = GAME_LEVEL;
      const selectedIconNames = shuffleArray([...allIconList]).slice(0, levelConfig.pairs);
      const gameIconNames = [...selectedIconNames, ...selectedIconNames];
      const shuffledIconNames = shuffleArray(gameIconNames);

      cards = shuffledIconNames.map((iconName, index) => ({
        id: index, iconName: iconName, isFlipped: false, isMatched: false,
      }));
      flippedCards = [];
      moves = 0;
      isChecking = false;
      justMatched = [];
      animatingMatch = []; // 追加
      elapsedTime = 0;
      apiResponse = null;
    };

    // --- カードのHTML生成 ---
    const createCardHTML = (card) => {
      const { id, iconName, isFlipped, isMatched } = card;
      const isAnimating = justMatched.includes(id); // 古いマッチアニメーション
      const isCurrentlyAnimatingMatch = animatingMatch.includes(id); // 新しいアニメーション

      // カードの状態に応じたスタイル
      const cardInnerClasses = `
        aspect-square rounded-lg shadow-lg flex items-center justify-center 
        cursor-pointer transition-all duration-300 ease-in-out
        transform-style-3d relative
        ${isFlipped || isMatched ? 'bg-cyan-800' : 'bg-gray-700 hover:bg-gray-600'}
        ${isFlipped && !isMatched ? 'rotate-y-180' : ''}
        ${isMatched && !isCurrentlyAnimatingMatch ? 'fade-out-match' : ''} <!-- マッチしてアニメーション終了後 -->${isCurrentlyAnimatingMatch ? 'matched-pulse-effect' : ''} <!-- マッチアニメーション中 -->`;

      return `
        <div class="w-full h-full perspective-1000" data-id="${id}">
          <div class="${cardInnerClasses}">
            <!-- カードの表面（アイコン） --><div class="absolute w-full h-full flex items-center justify-center backface-hidden rotate-y-180">
              <i data-lucide="${iconName.toLowerCase()}" class="w-1/2 h-1/2 text-cyan-300"></i>
            </div>
            
            <!-- カードの裏面（？マーク） --><div class="absolute w-full h-full flex items-center justify-center backface-hidden">
              ${!(isFlipped || isMatched) ? '<i data-lucide="help-circle" class="w-1/2 h-1/2 text-gray-400"></i>' : ''}
            </div>
          </div>
        </div>
      `;
    };

    // --- 画面描画 ---
    const renderApp = () => {
      let html = '';

      switch (gameState) {
        case 'SELECT':
          const baselineText = baselineResult 
            ? `(記録: ${baselineResult.moves}手 / ${baselineResult.time}秒)` 
            : '(未測定)';
          html = `
            <h1 class="text-4xl font-bold mb-4 text-cyan-300">ALCONCENT</h1>
            <p class="text-lg mb-8 text-gray-400">アルコール神経衰弱</p>
            <div class="space-y-4">
              <button id="start-baseline" class="w-full px-6 py-4 bg-blue-600 hover:bg-blue-700 rounded-lg shadow-lg text-lg font-bold">
                1. シラフ時の記録を測定
                <span class="block text-sm font-normal">${baselineText}</span>
              </button>
              <button id="start-check" class="w-full px-6 py-4 ${baselineResult ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-700 cursor-not-allowed'} rounded-lg shadow-lg text-lg font-bold" ${!baselineResult ? 'disabled' : ''}>
                2. 酔っ払い度をチェック
                <span class="block text-sm font-normal">${!baselineResult ? '先にシラフ時を測定してください' : ''}</span>
              </button>
            </div>
          `;
          break;

        case 'BASELINE':
        case 'CHECK':
          const title = gameState === 'BASELINE' ? 'シラフ時 測定中' : '酔っ払い度 チェック中';
          html = `
            <h1 class="text-3xl font-bold mb-2 text-cyan-300">${title}</h1>
            <div class="flex justify-between w-full text-lg mb-4 px-2">
              <p>Moves: <span id="moves-display">${moves}</span></p>
              <p>Time: <span id="timer-display">${elapsedTime} 秒</span></p>
            </div>
            <div 
              id="game-board" 
              class="grid gap-2 md:gap-4 w-full" 
              style="grid-template-columns: repeat(${GAME_LEVEL.cols}, minmax(0, 1fr));"
            >
              ${cards.map(createCardHTML).join('')}
            </div>
          `;
          break;

        case 'LOADING':
          html = `
            <h2 class="text-3xl font-bold mb-4">分析中...</h2>
            <p class="text-lg mb-8">あなたの脳の状態をGeminiが分析しています。</p>
            <div class="flex justify-center">
              <div class="loader"></div>
            </div>
          `;
          break;

        case 'RESULT':
          if (!apiResponse) {
            html = `
              <h2 class="text-3xl font-bold mb-4 text-red-500">分析エラー</h2>
              <p class="text-lg mb-8">分析に失敗しました。時間をおいてもう一度お試しください。</p>
              <button id="back-to-select" class="w-full px-6 py-4 bg-gray-600 hover:bg-gray-700 rounded-lg shadow-lg text-lg font-bold">
                ホームに戻る
              </button>
            `;
            break;
          }

          const { drunk_level, analysis } = apiResponse;
          const levelWidth = (drunk_level / 5) * 100;
          html = `
            <h2 class="text-3xl font-bold mb-4">分析結果</h2>
            <p class="text-lg mb-4">あなたの酔っ払い度は...</p>
            <p class="text-6xl font-bold mb-6">${drunk_level} <span class="text-2xl">/ 5</span></p>
            
            <div class="w-full px-4 mb-6">
              <div class="drunk-level-bar">
                <div class="drunk-level-fill" style="width: ${levelWidth}%;"></div>
              </div>
            </div>

            <div class="bg-gray-800 p-4 rounded-lg mb-8">
              <p class="text-lg text-cyan-300">AI神経科学者より:</p>
              <p class="text-md">${analysis}</p>
            </div>
            
            <div class="grid grid-cols-2 gap-4 text-sm mb-8">
              <div class="bg-gray-700 p-2 rounded">
                <p>シラフ時</p>
                <p>${baselineResult.moves}手 / ${baselineResult.time}秒</p>
              </div>
              <div class="bg-gray-700 p-2 rounded">
                <p>今回</p>
                <p>${currentResult.moves}手 / ${currentResult.time}秒</p>
              </div>
            </div>

            <button id="back-to-select" class="w-full px-6 py-4 bg-cyan-600 hover:bg-cyan-700 rounded-lg shadow-lg text-lg font-bold">
              もう一度チェックする
            </button>
          `;
          break;
      }

      appContainer.innerHTML = html;
      lucide.createIcons();

      if (gameState === 'RESULT' && apiResponse) {
        setTimeout(() => {
          const fillBar = document.querySelector('.drunk-level-fill');
          if (fillBar) fillBar.style.width = `${(apiResponse.drunk_level / 5) * 100}%`;
        }, 100);
      }
    };

    // --- API呼び出し ---
    async function fetchAnalysis() {
      gameState = 'LOADING';
      renderApp();

      try {
        const response = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseline: baselineResult,
            current: currentResult
          })
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        
        apiResponse = await response.json();
        gameState = 'RESULT';
        
      } catch (error) {
        console.error("Fetch Analysis Error:", error);
        apiResponse = null;
        gameState = 'RESULT';
      }
      renderApp();
    }

    // --- ゲームイベント処理 ---
    const handleCardClick = (id) => {
      if (isChecking || flippedCards.length === 2) return;
      const clickedCard = cards.find(card => card.id === id);
      if (clickedCard.isFlipped || clickedCard.isMatched) return;

      clickedCard.isFlipped = true;
      flippedCards.push(id);
      
      if (flippedCards.length === 2) {
        isChecking = true;
        moves++;
        document.getElementById('moves-display').textContent = moves;
        
        const [firstCardId, secondCardId] = flippedCards;
        const firstCard = cards.find(c => c.id === firstCardId);
        const secondCard = cards.find(c => c.id === secondCardId);

        if (firstCard.iconName === secondCard.iconName) {
          // --- マッチ ---
          animatingMatch = [firstCardId, secondCardId]; // アニメーション開始
          renderApp(); // アニメーションを適用するために再描画

          setTimeout(() => {
            // アニメーションが終わったら消す
            firstCard.isMatched = true;
            secondCard.isMatched = true;
            animatingMatch = []; // アニメーション解除
            
            flippedCards = [];
            isChecking = false;
            
            // --- ゲームクリアかチェック ---
            if (cards.every(card => card.isMatched)) {
              stopTimer();
              currentResult = { moves: moves, time: elapsedTime };
              
              if (gameState === 'BASELINE') {
                baselineResult = currentResult;
                localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(baselineResult));
                gameState = 'SELECT';
              } else if (gameState === 'CHECK') {
                fetchAnalysis();
              }
            }
            renderApp(); // マッチしたカードをフェードアウト＆次の状態へ
          }, 600); // キラキラアニメーションの時間 (0.6秒)
          
        } else {
          // --- ミスマッチ ---
          setTimeout(() => {
            firstCard.isFlipped = false;
            secondCard.isFlipped = false;
            flippedCards = [];
            isChecking = false;
            renderApp(); // カードを裏返す
          }, 1000);
        }
      }
      renderApp(); // 1枚めくった状態を描画
    };

    // --- 初期化 ---
    document.addEventListener('DOMContentLoaded', () => {
      appContainer = document.getElementById('app-container');

      const storedBaseline = localStorage.getItem(BASELINE_STORAGE_KEY);
      if (storedBaseline) {
        baselineResult = JSON.parse(storedBaseline);
      }

      appContainer.addEventListener('click', (event) => {
        const target = event.target.closest('button, [data-id]');
        if (!target) return;

        if (target.id === 'start-baseline') {
          gameState = 'BASELINE';
          initializeGame();
          startTimer();
          renderApp();
          return;
        }

        if (target.id === 'start-check') {
          gameState = 'CHECK';
          initializeGame();
          startTimer();
          renderApp();
          return;
        }

        if (target.id === 'back-to-select') {
          gameState = 'SELECT';
          renderApp();
          return;
        }

        if (target.dataset.id && (gameState === 'BASELINE' || gameState === 'CHECK')) {
          const id = parseInt(target.dataset.id, 10);
          handleCardClick(id);
          return;
        }
      });

      renderApp();
    });
  </script>
</body>
</html>
