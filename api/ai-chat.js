export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY не настроен в Vercel' });
  }

  const systemInstruction = `Ты — дружелюбный и умный ИИ-ассистент платформы пати-игр «Хатсит» (Hatsit). 
Твоя задача — отвечать пользователям естественно, коротко, с юмором и помогать им по сайту.
База знаний:
- На платформе 5 игр: Шпион, Алиас, Мафия, Бункер, Суд.
- Суд и Бункер поддерживают онлайн-комнаты по коду (через Supabase).
- Для входа в онлайн-комнату нужен 4-значный код или ссылка вида ?room=CODE.
- Если у пользователя баг или сложный вопрос, предлагай переключиться на форму связи с человеком в Discord.
Отвечай вежливо, коротко (до 2-3 предложений) и используй эмодзи.`;

  // Преобразуем входящую историю сообщений в формат Gemini REST API
  const rawMessages = req.body.messages || [];
  const contents = rawMessages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        contents: contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300
        }
      })
    });

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Ой, что-то я задумался. Попробуй еще раз!';
    
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
