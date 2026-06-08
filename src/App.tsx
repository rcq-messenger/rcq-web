import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { I18nProvider } from './lib/i18n-context'
import { IdentityProvider, useIdentity } from './lib/identity-context'
import { ThemeProvider } from './lib/theme-context'
import { WSProvider } from './lib/ws'
import { MessageReceiver } from './lib/message-receiver'
import { MessageToasts } from './components/MessageToasts'
import { Login } from './pages/Login'
import { Contacts } from './pages/Contacts'
import { Chat } from './pages/Chat'
import { Settings } from './pages/Settings'
import { PendingRequests } from './pages/PendingRequests'
import { AddContact } from './pages/AddContact'
import { Profile } from './pages/Profile'
import { GroupInfo } from './pages/GroupInfo'
import { JoinGroup } from './pages/JoinGroup'
import { Privacy } from './pages/Privacy'
import { defaultHome } from './lib/routing'

function Authed({ children }: { children: JSX.Element }) {
  const { identity } = useIdentity()
  if (!identity) return <Navigate to="/" replace />
  return children
}

function RootEntry() {
  const { identity } = useIdentity()
  if (identity) return <Navigate to={defaultHome()} replace />
  return <Login />
}

export default function App() {
  // Provider order: Theme is outermost (applies a class on <html>
  // before children paint), then I18n, then Identity (auth gate),
  // then WS which reads identity to open the socket, then Router.
  // Theme → I18n → Identity → WS → Router.
  return (
    <ThemeProvider>
      <I18nProvider>
        <IdentityProvider>
          <WSProvider>
            <MessageReceiver />
            <Router>
            <MessageToasts />
            <Routes>
              <Route path="/" element={<RootEntry />} />
              <Route
                path="/contacts"
                element={
                  <Authed>
                    <Contacts />
                  </Authed>
                }
              />
              <Route
                path="/chat/:uin"
                element={
                  <Authed>
                    <Chat />
                  </Authed>
                }
              />
              <Route
                path="/chat/g/:groupId"
                element={
                  <Authed>
                    <Chat />
                  </Authed>
                }
              />
              <Route
                path="/groups/:groupId"
                element={
                  <Authed>
                    <GroupInfo />
                  </Authed>
                }
              />
              <Route
                path="/g/:groupId"
                element={
                  <Authed>
                    <JoinGroup />
                  </Authed>
                }
              />
              <Route
                path="/profile"
                element={
                  <Authed>
                    <Profile />
                  </Authed>
                }
              />
              <Route
                path="/profile/:uin"
                element={
                  <Authed>
                    <Profile />
                  </Authed>
                }
              />
              <Route
                path="/add"
                element={
                  <Authed>
                    <AddContact />
                  </Authed>
                }
              />
              <Route
                path="/pending"
                element={
                  <Authed>
                    <PendingRequests />
                  </Authed>
                }
              />
              <Route
                path="/settings"
                element={
                  <Authed>
                    <Settings />
                  </Authed>
                }
              />
              <Route
                path="/privacy"
                element={
                  <Authed>
                    <Privacy />
                  </Authed>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Router>
          </WSProvider>
        </IdentityProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
