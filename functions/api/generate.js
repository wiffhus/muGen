// Cloudflare Pages Function
// POSTリクエストで { baseline: { moves, time }, current: { moves, time } } を受け取る

export async function onRequestPost(context) {
  try {
    // 1. Cloudflareの環境変数からAPIキーを取得
    // ※Cloudflareのダッシュボードで設定が必要！
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "APIキーが設定されていません。" }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    // 2. リクエストボディからスコアデータを取得
    const { baseline, current } = await context.request.json();
    if (!baseline || !current) {
      return new Response(JSON.stringify({ error: "スコアデータが不完全です。" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Geminiに渡すシステムプロンプト（理論的根拠）
    const systemPrompt = `
あなたはアルコールが脳機能に与える影響、特にワーキングメモリと短期記憶への影響を専門とする神経科学者です。
アルコールの摂取は、前頭前野の機能を低下させ、ワーキングメモリ（短期的な情報の保持と操作）の効率を悪化させます。
これにより、カードの場所を覚えることや、戦略的にカードを選ぶことが困難になります。
「手数（Moves）」の増加は、記憶の曖昧さや注意散漫によるミスの増加を示します。
「時間（Time）」の増加は、判断速度の低下や迷いを示します。

ユーザーから「シラフ時の神経衰弱ゲームの結果」と「飲酒時の結果」が提供されます。
これらの悪化の度合いに基づき、ユーザーの現在の「酔っ払い度」を分析してください。

分析結果は必ず指定されたJSONスキーマに従って、以下の2つのキーで返してください。
1. "drunk_level": 酔っ払い度を1（シラフ）〜5（泥酔）の5段階で評価した数値。
2. "analysis": ワーキングメモリや判断速度の低下に軽く触れつつ、ユーモラスかつ励ますような、短い分析コメント（日本語で100文字以内）。
`;

    // 4. Geminiに渡すユーザープロンプト
    const userQuery = `
シラフ時の結果: ${baseline.moves}手, ${baseline.time}秒
飲酒時の結果: ${current.moves}手, ${current.time}秒
分析をお願いします。
`;

    // 5. Gemini APIのペイロード（JSONスキーマを強制）
    const payload = {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          parts: [{ text: userQuery }],
          role: "user"
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            "drunk_level": { "type": "NUMBER" },
            "analysis": { "type": "STRING" }
          },
          required: ["drunk_level", "analysis"]
        }
      }
    };

    // 6. API呼び出しの実行
    const geminiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("Gemini API Error:", errorText);
      return new Response(JSON.stringify({ error: "Gemini APIの呼び出しに失敗しました。", details: errorText }), {
        status: geminiResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await geminiResponse.json();
    const candidate = result.candidates?.[0];

    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      console.error("Gemini Response Error:", result);
      return new Response(JSON.stringify({ error: "Gemini APIからのレスポンス形式が不正です。" }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 7. パースされたJSONテキスト（分析結果）をクライアントに返す
    const analysisJson = JSON.parse(candidate.content.parts[0].text);
    
    return new Response(JSON.stringify(analysisJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error("Function Error:", error);
    return new Response(JSON.stringify({ error: "サーバー内部エラーが発生しました。", details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
