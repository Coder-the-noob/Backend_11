const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;
app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.nfj0fog.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized" });
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );

    const database = client.db("bloodDonation");
    const usersCollection = database.collection("users");
    const donationRequestsCollection = database.collection("donationRequests");
    const fundingsCollection = database.collection("fundings");

    app.post("/users", async (req, res) => {
      const user = req.body;

      const existingUser = await usersCollection.findOne({ email: user.email });
      if (existingUser) {
        return res.send({ message: "User already exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.post("/auth/jwt", async (req, res) => {
      const { email } = req.body;

      const user = await usersCollection.findOne({ email });
      if (!user) {
        return res.status(401).send({ message: "unauthorized" });
      }

      const token = jwt.sign({ email }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });

      res.send({ token });
    });

    // role change api for admin use
    app.get("/users", verifyJWT, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.patch("/users/role/:id", verifyJWT, async (req, res) => {
      const { role } = req.body;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role } }
      );

      res.send(result);
    });

    app.patch("/users/status/:id", verifyJWT, async (req, res) => {
      const { status } = req.body;

      console.log("STATUS UPDATE:", req.params.id, status);

      if (!["active", "blocked"].includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
      );

      res.send(result);
    });

    app.get("/admin/stats", verifyJWT, async (req, res) => {
      const email = req.decoded.email;

      // check admin
      const admin = await usersCollection.findOne({ email });
      if (admin?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden" });
      }

      const totalUsers = await usersCollection.countDocuments();
      const totalRequests = await donationRequestsCollection.countDocuments();

      // funding bonus (for now 0)
      const totalFunding = 0;

      res.send({
        totalUsers,
        totalRequests,
        totalFunding,
      });
    });

    app.get("/users/me", verifyJWT, async (req, res) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });

    app.get("/donors", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;

      let query = { role: "donor", status: "active" };

      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;

      const donors = await usersCollection.find(query).toArray();
      res.send(donors);
    });

    app.post("/donation-requests", verifyJWT, async (req, res) => {
      const email = req.decoded.email;

      const user = await usersCollection.findOne({ email });
      if (user?.status === "blocked") {
        return res.status(403).send({ message: "Blocked user" });
      }

      const donationRequest = {
        ...req.body,
        requesterEmail: email,
        status: "pending",
        donor: {
          name: null,
          email: null,
        },
        createdAt: new Date(),
      };

      const result = await donationRequestsCollection.insertOne(
        donationRequest
      );
      res.send(result);
    });

    app.get("/donation-requests", verifyJWT, async (req, res) => {
      const { email, status, limit } = req.query;

      let query = {};
      if (email) query.requesterEmail = email;
      if (status) query.status = status;

      let cursor = donationRequestsCollection
        .find(query)
        .sort({ createdAt: -1 });

      if (limit) {
        cursor = cursor.limit(parseInt(limit));
      }

      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/donation-requests/:id", verifyJWT, async (req, res) => {
      const result = await donationRequestsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    app.patch("/donation-requests/status/:id", verifyJWT, async (req, res) => {
      const { status, donor } = req.body;

      const allowed = ["inprogress", "done", "canceled"];
      if (!allowed.includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const updateDoc = {
        status,
      };

      if (donor) {
        updateDoc.donor = donor;
      }

      const result = await donationRequestsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updateDoc }
      );

      res.send(result);
    });

    app.patch("/donation-requests/:id", verifyJWT, async (req, res) => {
      const result = await donationRequestsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
      );

      res.send(result);
    });
    app.delete("/donation-requests/:id", verifyJWT, async (req, res) => {
      const result = await donationRequestsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      const { amount } = req.body;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount * 100, // taka → paisa
        currency: "bdt",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.get("/fundings", verifyJWT, async (req, res) => {
      const result = await database
        .collection("fundings")
        .find()
        .sort({ date: -1 })
        .toArray();

      res.send(result);
    });

    app.get("/fundings/total", verifyJWT, async (req, res) => {
      const result = await database
        .collection("fundings")
        .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
        .toArray();

      res.send({ total: result[0]?.total || 0 });
    });

    app.post("/fundings", verifyJWT, async (req, res) => {
      const funding = {
        ...req.body,
        createdAt: new Date(),
      };

      const result = await fundingsCollection.insertOne(funding);
      res.send(result);
    });

    app.get("/fundings", verifyJWT, async (req, res) => {
      const email = req.query.email;

      let query = {};
      if (email) {
        query.email = email; // donor funding only
      }

      const result = await fundingsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.get("/fundings/total", verifyJWT, async (req, res) => {
      const result = await fundingsCollection
        .aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
            },
          },
        ])
        .toArray();

      const total = result[0]?.total || 0;
      res.send({ total });
    });

    app.get("/admin/chart-stats", verifyJWT, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();
      const totalRequests = await donationRequestsCollection.countDocuments();
      const pending = await donationRequestsCollection.countDocuments({
        status: "pending",
      });
      const completed = await donationRequestsCollection.countDocuments({
        status: "done",
      });

      res.send([
        { name: "Users", value: totalUsers },
        { name: "Requests", value: totalRequests },
        { name: "Pending", value: pending },
        { name: "Completed", value: completed },
      ]);
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Blood Donation is running");
});

app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});
