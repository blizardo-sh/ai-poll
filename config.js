/* ==========================================================
   НАСТРОЙКА ГОЛОСОВАНИЙ
   Firebase уже заполнен (проект AI-learning-surveys).
   Осталось одно: после публикации папки vote/ вписать её
   публичный адрес в voteUrl ниже.
   ========================================================== */
window.POLL_CONFIG = {

  // Конфиг веб-приложения Firebase (публичный по замыслу,
  // доступ ограничивают правила базы, они уже опубликованы)
  firebase: {
    apiKey: "AIzaSyC5G0D2Oy6DOH9d4cN5XbXY4JKW2F3jsq4",
    authDomain: "ai-learning-surveys.firebaseapp.com",
    databaseURL: "https://ai-learning-surveys-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "ai-learning-surveys",
    storageBucket: "ai-learning-surveys.firebasestorage.app",
    messagingSenderId: "1034569331177",
    appId: "1:1034569331177:web:f078c75266ccc36ca49b78"
  },

  // Публичный адрес страницы голосования (GitHub Pages)
  voteUrl: "https://blizardo-sh.github.io/ai-poll/"
};
