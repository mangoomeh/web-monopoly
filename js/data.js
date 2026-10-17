// Board, card and token data (classic London board).
"use strict";

const GROUPS = {
  brown:     { color: "#8b4f2b", houseCost: 50 },
  lightblue: { color: "#9fd8f2", houseCost: 50 },
  pink:      { color: "#d93a96", houseCost: 100 },
  orange:    { color: "#f7941d", houseCost: 100 },
  red:       { color: "#e3242b", houseCost: 150 },
  yellow:    { color: "#fef200", houseCost: 150 },
  green:     { color: "#1fb25a", houseCost: 200 },
  darkblue:  { color: "#0072bb", houseCost: 200 },
};

const prop = (name, group, price, rents) => ({ type: "property", name, group, price, rents });
const station = (name) => ({ type: "station", name, price: 200, icon: "🚂" });
const utility = (name, icon) => ({ type: "utility", name, price: 150, icon });

const BOARD = [
  { type: "go", name: "GO", icon: "⬅️" },
  prop("Old Kent Road", "brown", 60, [2, 10, 30, 90, 160, 250]),
  { type: "chest", name: "Community Chest", icon: "🎁" },
  prop("Whitechapel Road", "brown", 60, [4, 20, 60, 180, 320, 450]),
  { type: "tax", name: "Income Tax", amount: 200, icon: "💷" },
  station("King's Cross Station"),
  prop("The Angel, Islington", "lightblue", 100, [6, 30, 90, 270, 400, 550]),
  { type: "chance", name: "Chance", icon: "❓" },
  prop("Euston Road", "lightblue", 100, [6, 30, 90, 270, 400, 550]),
  prop("Pentonville Road", "lightblue", 120, [8, 40, 100, 300, 450, 600]),
  { type: "jail", name: "Jail", icon: "🚔" },
  prop("Pall Mall", "pink", 140, [10, 50, 150, 450, 625, 750]),
  utility("Electric Company", "💡"),
  prop("Whitehall", "pink", 140, [10, 50, 150, 450, 625, 750]),
  prop("Northumberland Avenue", "pink", 160, [12, 60, 180, 500, 700, 900]),
  station("Marylebone Station"),
  prop("Bow Street", "orange", 180, [14, 70, 200, 550, 750, 950]),
  { type: "chest", name: "Community Chest", icon: "🎁" },
  prop("Marlborough Street", "orange", 180, [14, 70, 200, 550, 750, 950]),
  prop("Vine Street", "orange", 200, [16, 80, 220, 600, 800, 1000]),
  { type: "parking", name: "Free Parking", icon: "🅿️" },
  prop("Strand", "red", 220, [18, 90, 250, 700, 875, 1050]),
  { type: "chance", name: "Chance", icon: "❓" },
  prop("Fleet Street", "red", 220, [18, 90, 250, 700, 875, 1050]),
  prop("Trafalgar Square", "red", 240, [20, 100, 300, 750, 925, 1100]),
  station("Fenchurch St. Station"),
  prop("Leicester Square", "yellow", 260, [22, 110, 330, 800, 975, 1150]),
  prop("Coventry Street", "yellow", 260, [22, 110, 330, 800, 975, 1150]),
  utility("Water Works", "🚰"),
  prop("Piccadilly", "yellow", 280, [24, 120, 360, 850, 1025, 1200]),
  { type: "gotojail", name: "Go To Jail", icon: "👮" },
  prop("Regent Street", "green", 300, [26, 130, 390, 900, 1100, 1275]),
  prop("Oxford Street", "green", 300, [26, 130, 390, 900, 1100, 1275]),
  { type: "chest", name: "Community Chest", icon: "🎁" },
  prop("Bond Street", "green", 320, [28, 150, 450, 1000, 1200, 1400]),
  station("Liverpool St. Station"),
  { type: "chance", name: "Chance", icon: "❓" },
  prop("Park Lane", "darkblue", 350, [35, 175, 500, 1100, 1300, 1500]),
  { type: "tax", name: "Super Tax", amount: 100, icon: "💍" },
  prop("Mayfair", "darkblue", 400, [50, 200, 600, 1400, 1700, 2000]),
];

// Card actions: money (+/-), move (absolute to), moveBack, nearest (station|utility),
// jail, jailFree, repairs, payEach, collectEach.
const CHANCE_CARDS = [
  { text: "Advance to GO. Collect £200.", action: "move", to: 0 },
  { text: "Advance to Trafalgar Square. If you pass GO, collect £200.", action: "move", to: 24 },
  { text: "Advance to Pall Mall. If you pass GO, collect £200.", action: "move", to: 11 },
  { text: "Advance to Mayfair.", action: "move", to: 39 },
  { text: "Take a trip to King's Cross Station. If you pass GO, collect £200.", action: "move", to: 5 },
  { text: "Advance to the nearest station. If owned, pay the owner twice the rent.", action: "nearest", kind: "station" },
  { text: "Advance to the nearest station. If owned, pay the owner twice the rent.", action: "nearest", kind: "station" },
  { text: "Advance to the nearest utility. If owned, pay the owner 10× your dice roll.", action: "nearest", kind: "utility" },
  { text: "The bank pays you a dividend of £50.", action: "money", amount: 50 },
  { text: "Get Out of Jail Free. Keep this card until needed.", action: "jailFree" },
  { text: "Go back 3 spaces.", action: "moveBack", steps: 3 },
  { text: "Go to Jail. Do not pass GO, do not collect £200.", action: "jail" },
  { text: "Make general repairs on all your property: £25 per house, £100 per hotel.", action: "repairs", house: 25, hotel: 100 },
  { text: "Speeding fine £15.", action: "money", amount: -15 },
  { text: "Your building loan matures. Collect £150.", action: "money", amount: 150 },
  { text: "You have been elected Chairman of the Board. Pay each player £50.", action: "payEach", amount: 50 },
];

const CHEST_CARDS = [
  { text: "Advance to GO. Collect £200.", action: "move", to: 0 },
  { text: "Bank error in your favour. Collect £200.", action: "money", amount: 200 },
  { text: "Doctor's fees. Pay £50.", action: "money", amount: -50 },
  { text: "From sale of stock you get £50.", action: "money", amount: 50 },
  { text: "Get Out of Jail Free. Keep this card until needed.", action: "jailFree" },
  { text: "Go to Jail. Do not pass GO, do not collect £200.", action: "jail" },
  { text: "Holiday fund matures. Receive £100.", action: "money", amount: 100 },
  { text: "Income tax refund. Collect £20.", action: "money", amount: 20 },
  { text: "It is your birthday. Collect £10 from every player.", action: "collectEach", amount: 10 },
  { text: "Life insurance matures. Collect £100.", action: "money", amount: 100 },
  { text: "Pay hospital fees of £100.", action: "money", amount: -100 },
  { text: "Pay school fees of £50.", action: "money", amount: -50 },
  { text: "Receive £25 consultancy fee.", action: "money", amount: 25 },
  { text: "You are assessed for street repairs: £40 per house, £115 per hotel.", action: "repairs", house: 40, hotel: 115 },
  { text: "You have won second prize in a beauty contest. Collect £10.", action: "money", amount: 10 },
  { text: "You inherit £100.", action: "money", amount: 100 },
];

const TOKENS = ["🎩", "🚗", "🐶", "🚢", "👢", "🐱", "🦖", "🦆"];
const PLAYER_COLORS = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa", "#fb8c00"];
const DEFAULT_NAMES = ["Player", "Ada", "Brunel", "Churchill", "Darwin", "Eliot"];

const RULES = {
  goSalary: 200,
  jailFine: 50,
  maxHouses: 32,
  maxHotels: 12,
  mortgageInterest: 0.1,
};
