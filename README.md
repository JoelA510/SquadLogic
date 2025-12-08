# SquadLogic

![SquadLogic Logo](logo.png)

> **Tagline will go here.**
>
> SquadLogic converts raw GotSport registration data into actionable teaming and scheduling frameworks, designed specifically to support youth sports organizations.

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/JoelA510/SquadLogic/actions)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)
[![Vite](https://img.shields.io/badge/Vite-5.4.21-646cff)](https://vitejs.dev/)

---

## 🚀 Overview

SquadLogic is a comprehensive tool for youth sports administrators. It simplifies the complex logistics of organizing leagues by automating team generation, practice scheduling, and game scheduling. Built with a modern tech stack and a "Deep Space Glass" design system, it offers a premium, intuitive user experience.

## ✨ Key Features

-   **🤖 Automated Team Generation**: Intelligent allocation of players to teams based on configurable criteria.
-   **wc Practice Scheduling**: Efficient scheduling of practice slots, minimizing conflicts and maximizing resource usage.
-   **⚽ Game Scheduling**: Round-robin game generation and allocation.
-   **💾 Persistence**: Robust data storage using Supabase (Edge Functions & Database).
-   **🎨 Deep Space Glass UI**: A stunning, responsive interface with dark/light/party modes, glassmorphism effects, and dynamic animations.
-   **📊 Analytics & Insights**: Real-time metrics and alerts for unassigned teams or scheduling conflicts.

## 🛠️ Tech Stack

-   **Frontend**: React 18, Vite 5
-   **Styling**: Vanilla CSS (Deep Space Glass Design System), CSS Variables
-   **Backend**: Node.js, Supabase (Edge Functions)
-   **Testing**: Node.js Native Test Runner
-   **Linting**: ESLint

## 🏁 Getting Started

### Prerequisites

-   Node.js (v20 or higher)
-   npm (v10 or higher)

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/JoelA510/SquadLogic.git
    cd SquadLogic
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Start the development server:**
    ```bash
    npm run frontend:dev
    ```
    The application will be available at `http://localhost:5173`.

### Building for Production

To create a production build:

```bash
npm run frontend:build
```

## Tb Project Structure

```
SquadLogic/
├── frontend/           # React frontend application
│   ├── src/            # Source code
│   │   ├── components/ # Reusable UI components
│   │   ├── App.css     # Global styles & component styles
│   │   ├── index.css   # Theme variables & reset
│   │   └── ...
│   └── ...
├── scripts/            # Build and utility scripts
├── docs/               # Documentation & Architecture decision records
├── tests/              # Test suites
└── ...
```

## 🗺️ Roadmap

We are actively developing SquadLogic. Check out our [Detailed Roadmap](roadmap.md) for upcoming features and milestones.

-   ✅ **Requirements & Architecture**
-   🚧 **Team Generation** (Client-side implemented, Server-side in progress)
-   🚧 **Practice Scheduling** (Scheduler implemented, Persistence next)
-   🚧 **Game Scheduling** (Generator implemented, Persistence next)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1.  Fork the project
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4.  Push to the branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

## 📄 License

This project is licensed under the [ISC License](https://opensource.org/licenses/ISC).
