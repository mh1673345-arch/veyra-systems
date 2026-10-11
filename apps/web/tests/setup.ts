import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's automatic cleanup hooks into a global afterEach, which
// vitest only registers when `globals: true`. This project runs with
// `globals: false`, so without this the DOM accumulates across tests in a file
// and queries match elements rendered by an earlier test.
afterEach(() => {
  cleanup();
});
