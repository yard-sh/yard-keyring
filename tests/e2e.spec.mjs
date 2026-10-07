// Keyring end to end, against `yard dev`. Four people, each in their own
// browser context, picked with the yard_dev_identity cookie:
//   landlord  user:landlord  pays for the Landlord plan
//   tenant    signed-in      invited to unit 1A
//   roommate  trial          the second tenant on 1A (also on a Landlord trial)
//   outsider  member         the project owner, with no part in this property
//
// The tests run in order and share one story: a property, a lease, two
// tenants, a request, a payment, and finally removal and deletion. Each test
// checks one thing, plainly.
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const people = {};
const story = {};

async function person(browser, id) {
  const context = await browser.newContext();
  await context.addCookies([{ name: "yard_dev_identity", value: id, domain: "localhost", path: "/" }]);
  const page = await context.newPage();
  return page;
}

test.beforeAll(async ({ browser }) => {
  people.landlord = await person(browser, "user:landlord");
  people.tenant = await person(browser, "signed-in");
  people.roommate = await person(browser, "trial");
  people.outsider = await person(browser, "member");
});

test.afterAll(async () => {
  for (const page of Object.values(people)) await page.context().close();
});

const inDialog = (page) => page.locator("dialog[open]");

test("the landing page builds its pricing from the project's tiers", async () => {
  const page = people.outsider;
  await page.goto("./");
  const tierId = await page.evaluate(() => window.yard.project.tiers.find((t) => t.key === "landlord").id);
  await expect(page.locator("#trialBtn")).toHaveAttribute("data-tier-id", tierId);
});

test("the landing page shows who is signed in", async () => {
  const page = people.landlord;
  await page.goto("./");
  await expect(page.locator("#auth")).toContainText("Your properties");
});

test("a landlord creates a property with units", async () => {
  const page = people.landlord;
  await page.goto("app/#/l");
  await page.getByRole("button", { name: "New property" }).first().click();
  await page.getByLabel("Name").fill("Maple Court");
  await page.getByLabel("Emergency line").fill("555-0199");
  await page.getByRole("button", { name: "Create property" }).click();
  await page.getByRole("button", { name: "Add units" }).first().click();
  await page.getByLabel("Unit numbers").fill("1A-1C");
  await inDialog(page).getByRole("button", { name: "Add units" }).click();
  await expect(page.locator(".roll__row[data-unit]")).toHaveCount(3);
  story.propertyId = page.url().match(/#\/l\/p\/([^/]+)/)[1];
});

test("starting a lease makes one invite link per tenant", async () => {
  const page = people.landlord;
  await page.locator('[data-unit="1A"]').click();
  await page.getByLabel("Monthly rent").fill("1850");
  await page.getByLabel("Lease starts").fill(new Date().toISOString().slice(0, 8) + "01");
  await page.getByLabel("Tenant emails").fill("signed-in@example.com, trial@example.com");
  await page.getByRole("button", { name: "Start lease and make invites" }).click();
  const links = inDialog(page).locator(".linkbox__url");
  await expect(links).toHaveCount(2);
  story.links = [await links.nth(0).inputValue(), await links.nth(1).inputValue()];
  await inDialog(page).getByRole("button", { name: "Done" }).click();
  story.unitURL = page.url();
});

test("a tenant opens their link, joins, and sees their unit number", async () => {
  const page = people.tenant;
  await page.goto(story.links[0]);
  await inDialog(page).getByRole("button", { name: "Join this unit" }).click();
  await expect(page.locator(".hanger__num")).toHaveText("1A");
  story.leaseId = page.url().match(/#\/t\/([^/]+)/)[1];
});

test("a used invite link can't be claimed again", async () => {
  const page = people.outsider;
  await page.goto(story.links[0]);
  await expect(page.locator("#toast")).toContainText("already used");
});

test("the roommate joins, and has both portals", async () => {
  const page = people.roommate;
  await page.goto(story.links[1]);
  await inDialog(page).getByRole("button", { name: "Join this unit" }).click();
  await expect(page.locator("#portals")).toBeVisible();
});

test("an outsider gets a 404 for the lease and the property", async () => {
  const page = people.outsider;
  const lease = await page.request.get(`app/api/leases/${story.leaseId}`);
  const property = await page.request.get(`app/api/properties/${story.propertyId}`);
  expect([lease.status(), property.status()]).toEqual([404, 404]);
});

test("a tenant can't reach landlord routes", async () => {
  const page = people.tenant;
  const res = await page.request.get(`app/api/properties/${story.propertyId}/rentroll`);
  expect(res.status()).toBe(403);
});

test("an announcement reaches the tenant's open home page live", async () => {
  const tenant = people.tenant;
  await tenant.goto(`app/#/t/${story.leaseId}`);
  await expect(tenant.locator("#livedot")).toBeVisible();
  const landlord = people.landlord;
  await landlord.goto(`app/#/l/p/${story.propertyId}/notices`);
  await landlord.getByLabel("Title").fill("Water off Friday");
  await landlord.getByLabel("Pin to the top").check();
  await landlord.getByRole("button", { name: "Post to all tenants" }).click();
  await expect(tenant.locator('[data-card="news"]')).toContainText("Water off Friday");
});

test("a new request reaches the landlord's open list live", async () => {
  const landlord = people.landlord;
  await landlord.goto(`app/#/l/p/${story.propertyId}/requests`);
  await expect(landlord.locator("#livedot")).toBeVisible();
  const tenant = people.tenant;
  await tenant.goto(`app/#/t/${story.leaseId}/requests/new`);
  await tenant.getByLabel("In a few words").fill("Kitchen sink drips");
  await tenant.getByRole("button", { name: "Send to landlord" }).click();
  await expect(tenant.locator(".thread")).toBeVisible();
  story.ticketURL = tenant.url();
  await expect(landlord.locator("[data-ticket]")).toContainText("Kitchen sink drips");
});

test("a status change reaches the tenant's open request live", async () => {
  const landlord = people.landlord;
  await landlord.locator("[data-ticket]").first().click();
  await expect(landlord.locator(".thread")).toBeVisible();
  await landlord.getByRole("button", { name: "In progress" }).click();
  await expect(people.tenant.locator(".tdetail__head .pill")).toHaveText("In progress");
});

test("the landlord sees the tenant typing", async () => {
  await people.tenant.getByLabel("Reply").fill("It's worse at night.");
  await expect(people.landlord.locator(".typing")).toContainText("is typing");
});

test("a tenant's comment reaches the landlord live", async () => {
  await people.tenant.getByRole("button", { name: "Send" }).click();
  await expect(people.landlord.locator("[data-comment]")).toContainText("It's worse at night.");
});

test("a landlord's reply reaches the tenant live", async () => {
  const landlord = people.landlord;
  await landlord.getByLabel("Reply").fill("Plumber Thursday morning.");
  await landlord.getByRole("button", { name: "Send" }).click();
  await expect(people.tenant.locator("[data-comment]").last()).toContainText("Plumber Thursday morning.");
});

test("the thread survives a reload, before and after its flush", async () => {
  const tenant = people.tenant;
  await tenant.reload();
  await expect(tenant.locator("[data-comment]")).toHaveCount(2);
  await tenant.waitForTimeout(6000); // the room writes comments to the database every 5 s
  await tenant.reload();
  await expect(tenant.locator("[data-comment]")).toHaveCount(2);
});

test("a declined test card is refused inside the checkout", async () => {
  const tenant = people.tenant;
  await tenant.goto(`app/#/t/${story.leaseId}`);
  await tenant.locator('[data-bill="due"]').getByRole("button", { name: /^Pay/ }).click();
  await inDialog(tenant).getByLabel("Card number").fill("4000 0000 0000 0002");
  await inDialog(tenant).getByRole("button", { name: /^Pay/ }).click();
  await expect(inDialog(tenant).locator(".modal__error")).toContainText("Declined");
});

test("a tenant's payment shows up on the landlord's rent roll live", async () => {
  const landlord = people.landlord;
  await landlord.goto(`app/#/l/p/${story.propertyId}`);
  // The first rent is due on the 1st: "Due" on the 1st itself, "Overdue" after.
  await expect(landlord.locator('[data-unit="1A"]')).toContainText(/Due|Overdue/);
  const tenant = people.tenant;
  await inDialog(tenant).getByLabel("Card number").fill("4242 4242 4242 4242");
  await inDialog(tenant).getByRole("button", { name: /^Pay/ }).click();
  await expect(inDialog(tenant).getByRole("heading", { name: "Payment complete" })).toBeVisible();
  await expect(landlord.locator('[data-unit="1A"]')).toContainText("Paid up");
});

test("the receipt says no money moved", async () => {
  const tenant = people.tenant;
  await inDialog(tenant).getByRole("link", { name: "View receipt" }).click();
  await expect(tenant.locator("[data-receipt]")).toContainText("no money moved");
});

test("the paid bill is still paid after a reload", async () => {
  const tenant = people.tenant;
  await tenant.goto(`app/#/t/${story.leaseId}`);
  await tenant.reload();
  await expect(tenant.locator('[data-bill="paid"]')).toBeVisible();
});

test("a tenant can withdraw a request the landlord hasn't picked up", async () => {
  const tenant = people.tenant;
  await tenant.goto(`app/#/t/${story.leaseId}/requests/new`);
  await tenant.getByLabel("In a few words").fill("Hallway light out");
  await tenant.getByRole("button", { name: "Send to landlord" }).click();
  await tenant.getByRole("button", { name: "Withdraw request" }).click();
  await inDialog(tenant).getByRole("button", { name: "Withdraw" }).click();
  await expect(tenant.locator("[data-ticket]")).toHaveCount(1); // only the sink is left
});

test("removing the roommate closes their open page at once", async () => {
  const roommate = people.roommate;
  await roommate.goto(`app/#/t/${story.leaseId}`);
  await expect(roommate.locator("#livedot")).toBeVisible();
  const landlord = people.landlord;
  await landlord.goto(story.unitURL);
  await landlord.getByRole("button", { name: /^Remove trial/ }).click();
  await inDialog(landlord).getByRole("button", { name: "Remove" }).click();
  await expect(roommate.locator(".empty--gone")).toContainText("no longer have access");
});

test("deleting the property closes the tenant's open page at once", async () => {
  const tenant = people.tenant;
  await tenant.goto(`app/#/t/${story.leaseId}`);
  await expect(tenant.locator("#livedot")).toBeVisible();
  const landlord = people.landlord;
  await landlord.goto(`app/#/l/p/${story.propertyId}/settings`);
  await landlord.getByRole("button", { name: "Delete property" }).click();
  await inDialog(landlord).getByLabel("Property name").fill("Maple Court");
  await inDialog(landlord).getByRole("button", { name: "Delete property" }).click();
  await expect(tenant.locator(".empty--gone")).toContainText("was deleted");
});
