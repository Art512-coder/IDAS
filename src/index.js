import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Make sure you have this file in src/
import App from './App'; // Make sure App.js is in src/

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
