const db = require('../db');

async function qaRoutes(fastify, options) {
  // 1. Listar preguntas en vivo
  fastify.get('/api/qa', async (req, reply) => {
    // Ordenadas por votos descendente
    const sorted = [...db.inMemoryStore.preguntas].sort((a, b) => b.votos - a.votos);
    return {
      success: true,
      count: sorted.length,
      questions: sorted
    };
  });

  // 2. Publicar nueva pregunta
  fastify.post('/api/qa/ask', async (req, reply) => {
    const { autor, pregunta } = req.body || {};

    if (!pregunta || pregunta.trim().length === 0) {
      return reply.status(400).send({ error: 'La pregunta no puede estar vacía' });
    }

    const newQuestion = {
      id: `qa-${Date.now()}`,
      autor: (autor || 'Asistente Anónimo').trim(),
      pregunta: pregunta.trim(),
      votos: 1,
      respondida: false,
      created_at: new Date().toISOString()
    };

    db.inMemoryStore.preguntas.unshift(newQuestion);

    return reply.status(201).send({
      success: true,
      message: 'Pregunta enviada a los speakers en vivo',
      question: newQuestion
    });
  });

  // 3. Votar por una pregunta (+1 voto)
  fastify.post('/api/qa/:id/upvote', async (req, reply) => {
    const { id } = req.params;
    const q = db.inMemoryStore.preguntas.find(item => item.id === id);

    if (!q) {
      return reply.status(404).send({ error: 'Pregunta no encontrada' });
    }

    q.votos += 1;

    return {
      success: true,
      votos: q.votos
    };
  });

  // 4. Marcar como respondida (Panel de Speaker / Moderador)
  fastify.post('/api/qa/:id/toggle-answered', async (req, reply) => {
    const { id } = req.params;
    const q = db.inMemoryStore.preguntas.find(item => item.id === id);

    if (!q) {
      return reply.status(404).send({ error: 'Pregunta no encontrada' });
    }

    q.respondida = !q.respondida;

    return {
      success: true,
      respondida: q.respondida
    };
  });
}

module.exports = qaRoutes;
