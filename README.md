# Conversation Coach

Copiloto para qualquer reunião. Antes, você escreve o roteiro (com quem é, o que cada pessoa quer, seu objetivo, os pontos que quer levantar e o que evitar) e o Claude confirma o que entendeu. Durante a reunião, a página escuta a conversa (transcrição do navegador em pt-BR), separa você dos outros e só sugere algo quando há uma fala útil. No fim, o Claude escreve o resumo: decisões, quem faz o quê, pendências e os pontos que você não levantou.

Abra o link do GitHub Pages deste repositório no **Google Chrome do computador**. As sugestões usam a API da Anthropic com a sua própria chave, guardada só no seu navegador.

A página é gerada a partir do projeto `coach-app` (`npm run build:artifact`). O workflow `verify-site` abre o link publicado no Google Chrome e confere escuta, detecção de quem fala, sugestões e resumo (a API é simulada no teste).
