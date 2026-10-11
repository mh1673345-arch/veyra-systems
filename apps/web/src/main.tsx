import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./dashboard/AuthContext";
import { DashboardLayout, RequireAuth } from "./dashboard/DashboardLayout";
import { LoginPage } from "./dashboard/LoginPage";
import { OverviewPage } from "./dashboard/OverviewPage";
import { ConversationDetailPage, ConversationsPage } from "./dashboard/ConversationsPage";
import { BookingDetailPage, BookingsPage } from "./dashboard/BookingsPage";
import { EscalationDetailPage, EscalationsPage } from "./dashboard/EscalationsPage";
import { SettingsPage } from "./dashboard/SettingsPage";
import { PilotPage } from "./dashboard/pilot/PilotPage";
import { CallDetailPage, CallsPage } from "./dashboard/voice/CallsPage";
import { PilotIssuesPage } from "./dashboard/pilot/PilotIssuesPage";
import { MembersPage } from "./dashboard/MembersPage";
import { AccountPage } from "./dashboard/AccountPage";
import { WorkQueuePage } from "./dashboard/WorkQueuePage";
import { SignupPage } from "./dashboard/SignupPage";
import { CreateWorkspacePage } from "./dashboard/CreateWorkspacePage";
import { SetupWizard } from "./dashboard/setup/SetupWizard";
import "./styles.css";
import "./dashboard/dashboard.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public reception demo, unchanged. */}
          <Route path="/" element={<App />} />

          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route
            path="/dashboard/new"
            element={
              <RequireAuth>
                <CreateWorkspacePage />
              </RequireAuth>
            }
          />

          {/* Operator dashboard — every route behind an authenticated session. */}
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <DashboardLayout />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard/:businessId"
            element={
              <RequireAuth>
                <DashboardLayout />
              </RequireAuth>
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="work-queue" element={<WorkQueuePage />} />
            <Route path="conversations" element={<ConversationsPage />} />
            <Route path="conversations/:conversationId" element={<ConversationDetailPage />} />
            <Route path="bookings" element={<BookingsPage />} />
            <Route path="bookings/:bookingId" element={<BookingDetailPage />} />
            <Route path="escalations" element={<EscalationsPage />} />
            <Route path="escalations/:escalationId" element={<EscalationDetailPage />} />
            <Route path="calls" element={<CallsPage />} />
            <Route path="calls/:callId" element={<CallDetailPage />} />
            <Route path="pilot" element={<PilotPage />} />
            <Route path="pilot/issues" element={<PilotIssuesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="setup" element={<SetupWizard />} />
            <Route path="setup/:step" element={<SetupWizard />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
