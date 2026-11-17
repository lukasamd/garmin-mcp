# Garmin MCP — instrukcja po polsku

Projekt daje asystentowi AI dostęp tylko do odczytu do danych własnego konta Garmin za pośrednictwem oficjalnego Garmin Connect Personal API. Jest forkiem [barcia/garmin-mcp](https://github.com/barcia/garmin-mcp), rozszerzonym o odczyt VO₂ max i listę typów aktywności. Kompletny poradnik dla początkujących znajduje się w `website/public/index.html` i będzie opublikowany osobno.

## Co jest potrzebne

- Konto Garmin Connect i własny klucz Personal API.
- Konto Cloudflare z Workers, KV i Zero Trust Access; projekt jest przeznaczony do użytku w granicach planu Free.
- Node.js, pnpm i Git oraz asystent obsługujący zdalne MCP z OAuth.

Dostępność własnych MCP zależy od klienta, planu i kraju. Ten serwer nie udostępnia zapisu do Garmin. Nie jest produktem Garmin ani dostawców asystentów AI.

## Instalacja

1. Sklonuj repozytorium i uruchom `pnpm install --frozen-lockfile`, `pnpm check` oraz `pnpm wrangler login`.
2. W Cloudflare Workers & Pages utwórz Workera `garmin-mcp` i skonfiguruj subdomenę `workers.dev`.
3. W Zero Trust utwórz aplikację Self-hosted dla adresu Workera i wyłącznie ścieżki `/authorize`. Ustaw politykę Allow tylko dla swojego adresu e-mail i logowanie kodem One-time PIN. W prywatnym oknie sprawdź, że pojawia się ekran logowania Cloudflare Access. Skopiuj Application Audience (AUD) Tag.
4. W katalogu projektu uruchom `pnpm wrangler secret put ACCESS_AUD` i wprowadź AUD przy ukrytym monicie.
5. Utwórz klucz na [stronie Garmin Personal API](https://connect.garmin.com/app/settings/personalApiToken). Uruchom `pnpm wrangler secret put GARMIN_API_KEY` i wprowadź klucz przy ukrytym monicie. Klucz jest widoczny tylko raz; usunięcie istniejącego unieważnia powiązane z nim tokeny.
6. Uruchom `pnpm wrangler deploy`. W razie pytania potwierdź utworzenie namespace KV.
7. Sprawdź, czy niezalogowane żądanie do `https://TWOJ-WORKER.workers.dev/mcp` zwraca HTTP 401. W kliencie AI dodaj ten adres jako serwer MCP z OAuth. Zaloguj się przez Access i zweryfikuj dane na stronie zgody.
8. Poproś asystenta o odczyt przykładowej aktywności, HRV i snu. Samo HTTP 401 nie jest pełnym testem bezpieczeństwa.

Nie wysyłaj kluczy, tokenów, kodów logowania ani danych zdrowotnych do autora projektu. Nie wpisuj sekretów w poleceniach, historii powłoki ani plikach repozytorium. Sprawdź zawartość komunikatów błędów przed ich udostępnieniem.

## Utrzymanie

Klucz Garmin ma określoną datę ważności. Przy wymianie utwórz nowy klucz i uruchom `pnpm wrangler secret put GARMIN_API_KEY`. Wygenerowany lokalnie identyfikator KV zachowaj we własnej konfiguracji i nie publikuj go jako domyślnego ustawienia dla innych.

Aby odłączyć pojedynczego klienta, usuń połączenie w jego ustawieniach. Żeby unieważnić wszystkie autoryzacje serwera, wyczyść wyłącznie jego namespace KV; klienci będą musieli połączyć się ponownie. Usunięcie klucza w Garmin unieważnia klucz i powiązane tokeny Garmin.

## Zakres i koszty

Ten projekt korzysta z Cloudflare Workers, KV i Access. Jego uruchomienie na innym hostingu wymaga dostosowania kodu i autoryzacji; nie opisujemy takiej ścieżki jako działającej. Usługi Free mają limity; w szczególności dekodowanie dużych plików FIT może przekroczyć limit CPU. Dostawca AI otrzymuje dane pobrane do rozmowy. Oceny treningowe asystenta nie są diagnozą.
